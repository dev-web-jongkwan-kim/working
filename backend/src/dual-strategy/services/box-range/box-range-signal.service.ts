import { Injectable } from '@nestjs/common';
import { BOX_RANGE_CONFIG } from '../../constants/box-range.config';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Candle } from '../../interfaces/candle.interface';
import { BoxDetectorService } from './box-detector.service';
import { BoxEntryAnalyzerService } from './box-entry-analyzer.service';
import { DataCacheService } from '../data/data-cache.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { ActiveBoxCache } from '../../interfaces/box.interface';

/**
 * Box Range Signal Service
 * Main integration service for box range strategy
 * Manages active boxes cache and signal generation
 *
 * [개선 2026-01-24]
 * - ATR 저변동: 차단 → LowVolMode
 * - Same-box Loss Limiter 추가
 * - Viability Filter (TP거리/스프레드) 추가
 */
@Injectable()
export class BoxRangeSignalService {
  private activeBoxes: Map<string, ActiveBoxCache> = new Map();
  private disabledSymbols: Map<string, number> = new Map(); // symbol -> disabledUntil timestamp
  // 개선: 같은 박스 손절 횟수 추적
  private boxLossCount: Map<string, { count: number; lastLossTime: number }> = new Map();

  constructor(
    private readonly boxDetector: BoxDetectorService,
    private readonly entryAnalyzer: BoxEntryAnalyzerService,
    private readonly dataCache: DataCacheService,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Main signal detection function
   */
  async detect(symbol: string, candles: Candle[], currentPrice: number, fundingRate: number): Promise<TradingSignal> {
    this.logger.debug(
      `[BoxRangeSignal] ${symbol} Starting box range analysis`,
      'BoxRangeSignal',
    );

    // 1. Check if symbol is disabled (by Cycle Rider or breakout)
    if (this.isSymbolDisabled(symbol)) {
      const disabledUntil = this.disabledSymbols.get(symbol);
      const remainingMinutes = disabledUntil ? Math.ceil((disabledUntil - Date.now()) / 60000) : 0;

      this.logger.debug(
        `[BoxRangeSignal] ${symbol} Symbol disabled for ${remainingMinutes} more minutes`,
        'BoxRangeSignal',
      );

      return { detected: false } as any;
    }

    // 2. Check common filters (개선: LowVolMode 플래그 확인)
    const filterResult = this.passesCommonFilters(candles, symbol);
    if (!filterResult.passed) {
      return { detected: false } as any;
    }
    const isLowVolMode = filterResult.isLowVol || false;

    // 3. Check if we have an active box for this symbol
    let box = this.getActiveBox(symbol);

    // 4. If no active box, try to detect one
    if (!box) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} No active box, attempting detection`,
        'BoxRangeSignal',
      );

      box = await this.boxDetector.detectBox(symbol, candles);

      if (box) {
        // Cache the detected box
        this.cacheActiveBox(symbol, box);
        this.logger.log(
          `[BoxRangeSignal] ${symbol} ✅ New box cached! Grade=${box.grade}, ` +
            `upper=${box.upper.toFixed(2)}, lower=${box.lower.toFixed(2)}`,
          'BoxRangeSignal',
        );
      } else {
        return { detected: false } as any;
      }
    } else {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} Using cached box (grade=${box.grade}, age=${box.candlesInBox} candles)`,
        'BoxRangeSignal',
      );

      // Check if cached box is still valid
      if (!this.isBoxStillValid(box, currentPrice, symbol)) {
        this.logger.log(
          `[BoxRangeSignal] ${symbol} Cached box no longer valid, removing`,
          'BoxRangeSignal',
        );
        this.removeActiveBox(symbol);
        return { detected: false } as any;
      }
    }

    // 5. Check upper timeframe filters
    if (BOX_RANGE_CONFIG.upperTimeframeFilter.enabled) {
      const upperTfValid = await this.checkUpperTimeframeFilter(symbol);
      if (!upperTfValid) {
        this.logger.debug(
          `[BoxRangeSignal] ${symbol} ❌ Failed upper timeframe filter (check 1H ADX above)`,
          'BoxRangeSignal',
        );
        return { detected: false } as any;
      } else {
        this.logger.debug(
          `[BoxRangeSignal] ${symbol} ✅ Passed upper timeframe filter`,
          'BoxRangeSignal',
        );
      }
    }

    // 6. Analyze entry conditions (개선: LowVolMode, 확장박스 플래그 전달)
    const entrySignal = await this.entryAnalyzer.analyzeEntry(
      box,
      candles,
      currentPrice,
      fundingRate,
      { isLowVolMode, isExpandedBox: box.isExpandedBox },
    );

    if (!entrySignal) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} ❌ No entry signal generated (check entry analyzer logs above for details)`,
        'BoxRangeSignal',
      );
      return { detected: false } as any;
    }

    // 6.5 개선: Viability Filter 체크
    if (!this.passesViabilityFilter(symbol, box, entrySignal.entryPrice, entrySignal.direction)) {
      return { detected: false } as any;
    }

    // 7. Adjust position size based on multiple factors (개선)
    let adjustedMarginUsd = entrySignal.marginUsd;
    let sizeAdjustmentReasons: string[] = [];

    // 7a. Swing Quality 조정
    if (box.swingQuality === 'MEDIUM') {
      adjustedMarginUsd *= 0.75;
      sizeAdjustmentReasons.push('MEDIUM quality: 75%');
    } else if (box.swingQuality === 'HIGH') {
      sizeAdjustmentReasons.push('HIGH quality: 100%');
    }

    // 7b. 개선: ADX 기반 사이즈 조정
    if (box.adxSizeMultiplier && box.adxSizeMultiplier < 1.0) {
      adjustedMarginUsd *= box.adxSizeMultiplier;
      sizeAdjustmentReasons.push(`ADX elevated: ${Math.round(box.adxSizeMultiplier * 100)}%`);
    }

    // 7c. 개선: LowVolMode 사이즈 조정
    const lowVolConfig = (BOX_RANGE_CONFIG as any).lowVolMode;
    if (isLowVolMode && lowVolConfig?.adjustments?.sizeMultiplier) {
      adjustedMarginUsd *= lowVolConfig.adjustments.sizeMultiplier;
      sizeAdjustmentReasons.push(`LowVol: ${Math.round(lowVolConfig.adjustments.sizeMultiplier * 100)}%`);
    }

    // 7d. 개선: 확장 박스 사이즈 조정
    const expandedBoxConfig = (BOX_RANGE_CONFIG as any).boxDefinition?.expandedBox;
    if (box.isExpandedBox && expandedBoxConfig?.sizeMultiplier) {
      adjustedMarginUsd *= expandedBoxConfig.sizeMultiplier;
      sizeAdjustmentReasons.push(`Expanded box: ${Math.round(expandedBoxConfig.sizeMultiplier * 100)}%`);
    }

    const sizeAdjustmentReason = sizeAdjustmentReasons.join(' + ');
    this.logger.log(
      `[BoxRangeSignal] ${symbol} Size adjustment: ${entrySignal.marginUsd.toFixed(1)} → ${adjustedMarginUsd.toFixed(1)} (${sizeAdjustmentReason})`,
      'BoxRangeSignal',
    );

    // 8. Convert to TradingSignal format
    const tradingSignal: TradingSignal = {
      detected: true,
      strategyType: StrategyType.BOX_RANGE,
      subStrategy: `box_${box.grade.toLowerCase()}_${box.swingQuality.toLowerCase()}`, // box_a_high, box_b_medium, etc
      symbol,
      direction: entrySignal.direction === 'LONG' ? TradeDirection.LONG : TradeDirection.SHORT,
      entryPrice: entrySignal.entryPrice,
      slPrice: entrySignal.slPrice,
      tp1Price: entrySignal.tp1Price,
      tp2Price: entrySignal.tp2Price,
      useTrailing: false, // Box range uses fixed TPs
      confidence: entrySignal.confidence,
      riskRewardRatio: this.calculateRiskReward(entrySignal),
      metadata: {
        boxGrade: box.grade,
        boxSwingQuality: box.swingQuality,
        boxUpper: box.upper,
        boxLower: box.lower,
        boxHeight: box.height,
        boxHeightAtr: box.heightAtrRatio,
        boxAgeCandles: box.candlesInBox,
        boxAgeStatus: box.ageStatus,
        swingHighDeviation: box.highDeviation,
        swingLowDeviation: box.lowDeviation,
        swingMaxDeviation: box.maxDeviationValue,
        adx: box.adx,
        rsi: entrySignal.rsi,
        fundingRate: entrySignal.fundingRate,
        leverage: entrySignal.leverage,
        marginUsd: adjustedMarginUsd, // Adjusted margin based on quality
        originalMarginUsd: entrySignal.marginUsd,
        sizeAdjustmentReason,
        tp3Price: entrySignal.tp3Price, // Store TP3 in metadata
        touchCount: box.swingHighs.length + box.swingLows.length,
        // 개선: 추가 메타데이터
        volumeBoxType: box.volumeBoxType,
        isLowVolMode,
        isExpandedBox: box.isExpandedBox,
        adxSizeMultiplier: box.adxSizeMultiplier,
      },
    };

    this.logger.log(
      `[BoxRangeSignal] ${symbol} 🎯 Box Range signal generated! ` +
        `Grade=${box.grade}, Quality=${box.swingQuality}, Direction=${entrySignal.direction}, ` +
        `Entry=${entrySignal.entryPrice.toFixed(2)}, Confidence=${entrySignal.confidence.toFixed(1)}, ` +
        `SwingDev=[H:${box.highDeviation.toFixed(3)}, L:${box.lowDeviation.toFixed(3)}], ` +
        `Margin=${adjustedMarginUsd.toFixed(1)} (${sizeAdjustmentReason})`,
      'BoxRangeSignal',
    );

    return tradingSignal;
  }

  /**
   * Disable box range for a symbol (called by Cycle Rider or breakout)
   */
  disableSymbol(symbol: string, durationMinutes: number, reason: string): void {
    const disabledUntil = Date.now() + durationMinutes * 60000;
    this.disabledSymbols.set(symbol, disabledUntil);

    // Also remove any active box
    this.removeActiveBox(symbol);

    this.logger.log(
      `[BoxRangeSignal] ${symbol} 🚫 Disabled for ${durationMinutes} minutes. Reason: ${reason}`,
      'BoxRangeSignal',
    );
  }

  /**
   * Disable box range when Cycle Rider signals on same symbol
   */
  disableByCycleRider(symbol: string): void {
    if (BOX_RANGE_CONFIG.conflictResolution.disableOnCycleRiderSignal) {
      this.disableSymbol(
        symbol,
        BOX_RANGE_CONFIG.conflictResolution.disableDurationMinutes,
        'Cycle Rider signal detected',
      );
    }
  }

  /**
   * Check if symbol is currently disabled
   */
  private isSymbolDisabled(symbol: string): boolean {
    const disabledUntil = this.disabledSymbols.get(symbol);
    if (!disabledUntil) {
      return false;
    }

    if (Date.now() >= disabledUntil) {
      // Expired, remove
      this.disabledSymbols.delete(symbol);
      return false;
    }

    return true;
  }

  /**
   * Check entry conditions for active box (1분봉용 - 박스 재감지 없이 진입만 체크)
   * @returns TradingSignal if entry conditions met, null otherwise
   */
  async checkEntryOnly(symbol: string, currentPrice: number, fundingRate: number): Promise<any> {
    // 활성 박스 확인
    const box = this.getActiveBox(symbol);
    if (!box) {
      return null;
    }

    this.logger.log(
      `[1M-Entry] ${symbol} Checking entry for active box @ ${currentPrice.toFixed(4)}`,
      'BoxRangeSignal',
    );

    // 심볼이 비활성화되어 있는지 확인
    if (this.isSymbolDisabled(symbol)) {
      const disabledUntil = this.disabledSymbols.get(symbol);
      const remainingMinutes = disabledUntil ? Math.ceil((disabledUntil - Date.now()) / 60000) : 0;

      this.logger.debug(
        `[1M-Entry] ${symbol} Symbol disabled for ${remainingMinutes} more minutes`,
        'BoxRangeSignal',
      );
      return null;
    }

    // 박스 유효성 확인 (돌파 여부)
    if (!this.isBoxStillValid(box, currentPrice, symbol)) {
      this.logger.log(
        `[1M-Entry] ${symbol} Box no longer valid, removing from cache`,
        'BoxRangeSignal',
      );
      this.removeActiveBox(symbol);
      return null;
    }

    // 진입 조건 분석 (EntryAnalyzer 사용)
    // 캔들 데이터가 필요하므로 캐시에서 가져옴
    const candles = await this.dataCache.getRecentCandles(symbol, '15m', 100);
    if (!candles || candles.length < 50) {
      return null;
    }

    const entrySignal = await this.entryAnalyzer.analyzeEntry(box, candles, currentPrice, fundingRate);

    if (!entrySignal) {
      this.logger.debug(
        `[1M-Entry] ${symbol} No entry signal (price=${currentPrice.toFixed(4)}, box=${box.lower.toFixed(4)}-${box.upper.toFixed(4)})`,
        'BoxRangeSignal',
      );
      return null;
    }

    // Swing Quality에 따른 사이즈 조정
    let adjustedMarginUsd = entrySignal.marginUsd;
    let sizeAdjustmentReason = '';

    if (box.swingQuality === 'MEDIUM') {
      adjustedMarginUsd = entrySignal.marginUsd * 0.75;
      sizeAdjustmentReason = 'MEDIUM quality: 75% position size';
    } else if (box.swingQuality === 'HIGH') {
      sizeAdjustmentReason = 'HIGH quality: 100% position size';
    }

    // TradingSignal 생성
    const tradingSignal = {
      detected: true,
      strategyType: 'BOX_RANGE' as any,
      subStrategy: `box_${box.grade.toLowerCase()}_${box.swingQuality.toLowerCase()}_1m`,
      symbol,
      direction: entrySignal.direction === 'LONG' ? 'LONG' as any : 'SHORT' as any,
      entryPrice: entrySignal.entryPrice,
      slPrice: entrySignal.slPrice,
      tp1Price: entrySignal.tp1Price,
      tp2Price: entrySignal.tp2Price,
      useTrailing: false,
      confidence: entrySignal.confidence,
      riskRewardRatio: this.calculateRiskReward(entrySignal),
      metadata: {
        boxGrade: box.grade,
        boxSwingQuality: box.swingQuality,
        boxUpper: box.upper,
        boxLower: box.lower,
        boxHeight: box.height,
        boxHeightAtr: box.heightAtrRatio,
        boxAgeCandles: box.candlesInBox,
        boxAgeStatus: box.ageStatus,
        swingHighDeviation: box.highDeviation,
        swingLowDeviation: box.lowDeviation,
        swingMaxDeviation: box.maxDeviationValue,
        adx: box.adx,
        rsi: entrySignal.rsi,
        fundingRate: entrySignal.fundingRate,
        leverage: entrySignal.leverage,
        marginUsd: adjustedMarginUsd,
        originalMarginUsd: entrySignal.marginUsd,
        sizeAdjustmentReason,
        tp3Price: entrySignal.tp3Price,
        touchCount: box.swingHighs.length + box.swingLows.length,
        triggeredBy: '1m-candle', // 1분봉 트리거 표시
      },
    };

    this.logger.log(
      `[1M-Entry] ${symbol} ⚡ 1분봉 진입 신호! Grade=${box.grade}, Quality=${box.swingQuality}, ` +
        `Direction=${entrySignal.direction}, Entry=${entrySignal.entryPrice.toFixed(4)}, ` +
        `Confidence=${entrySignal.confidence.toFixed(1)}, Margin=${adjustedMarginUsd.toFixed(1)}`,
      'BoxRangeSignal',
    );

    return tradingSignal;
  }

  /**
   * Check if symbol has an active box (1분봉 필터링용)
   */
  hasActiveBox(symbol: string): boolean {
    return this.activeBoxes.has(symbol);
  }

  /**
   * Get list of symbols with active boxes (1분봉 필터링용)
   */
  getActiveBoxSymbols(): string[] {
    return Array.from(this.activeBoxes.keys());
  }

  /**
   * Get active box from cache
   */
  private getActiveBox(symbol: string) {
    const cached = this.activeBoxes.get(symbol);
    if (!cached) {
      return null;
    }

    // Check if cache is stale (older than 1 hour)
    const cacheAge = Date.now() - cached.lastUpdated;
    if (cacheAge > 60 * 60 * 1000) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} Cache stale (${Math.floor(cacheAge / 60000)} minutes old), removing`,
        'BoxRangeSignal',
      );
      this.activeBoxes.delete(symbol);
      return null;
    }

    return cached.box;
  }

  /**
   * Cache active box
   */
  private cacheActiveBox(symbol: string, box: any): void {
    this.activeBoxes.set(symbol, {
      box,
      lastUpdated: Date.now(),
    });
  }

  /**
   * Remove active box from cache
   */
  private removeActiveBox(symbol: string): void {
    this.activeBoxes.delete(symbol);
  }

  /**
   * Check if box is still valid
   */
  private isBoxStillValid(box: any, currentPrice: number, symbol: string): boolean {
    // 1. Check if price has broken out of box
    const breachPercent = BOX_RANGE_CONFIG.breakoutProtection.thresholdPercent;
    const upperBreakout = currentPrice > box.upper * (1 + breachPercent);
    const lowerBreakout = currentPrice < box.lower * (1 - breachPercent);

    if (upperBreakout || lowerBreakout) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} Box invalidated by price breakout ` +
          `(price=${currentPrice.toFixed(2)}, box=${box.lower.toFixed(2)}-${box.upper.toFixed(2)})`,
        'BoxRangeSignal',
      );
      return false;
    }

    // 2. Check if box has expired
    const ageMinutes = (box.candlesInBox * 15);
    const maxAgeMinutes = BOX_RANGE_CONFIG.boxDefinition.time.expireCandles * 15;

    if (ageMinutes >= maxAgeMinutes) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} Box expired (age=${ageMinutes} minutes, max=${maxAgeMinutes})`,
        'BoxRangeSignal',
      );
      return false;
    }

    return true;
  }

  /**
   * Check common filters (ATR, spread, volume)
   * 개선: ATR 저변동은 차단하지 않고 LowVolMode 플래그만 설정
   */
  private passesCommonFilters(candles: Candle[], symbol: string): { passed: boolean; isLowVol?: boolean; atrPercent?: number } {
    const { filters } = BOX_RANGE_CONFIG;
    const lowVolConfig = (BOX_RANGE_CONFIG as any).lowVolMode;

    // DEBUG: Log candle info
    this.logger.debug(
      `[BoxRangeSignal] ${symbol} Checking filters with ${candles.length} candles`,
      'BoxRangeSignal',
    );

    // ATR filter
    const atr = require('../../utils/indicators').Indicators.calculateAtr(candles, 14);
    const currentPrice = candles[candles.length - 1].close;
    const atrPercent = atr / currentPrice;

    this.logger.debug(
      `[BoxRangeSignal] ${symbol} ATR=${atr.toFixed(8)}, Price=${currentPrice.toFixed(4)}, ATR%=${(atrPercent * 100).toFixed(2)}%`,
      'BoxRangeSignal',
    );

    // 개선: 고변동(상한 초과)만 차단, 저변동은 LowVolMode
    if (atrPercent > filters.maxAtrPercent) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} ❌ ATR too high: ${(atrPercent * 100).toFixed(2)}% > ${filters.maxAtrPercent * 100}%`,
        'BoxRangeSignal',
      );
      return { passed: false };
    }

    // 개선: 저변동은 LowVolMode로 허용
    const isLowVol = lowVolConfig?.enabled && atrPercent < (lowVolConfig?.triggerAtrPercent || filters.minAtrPercent);
    if (isLowVol) {
      this.logger.log(
        `[BoxRangeSignal] ${symbol} ⚠️ LowVolMode activated: ATR%=${(atrPercent * 100).toFixed(2)}% < ${((lowVolConfig?.triggerAtrPercent || filters.minAtrPercent) * 100).toFixed(2)}%`,
        'BoxRangeSignal',
      );
    }

    return { passed: true, isLowVol, atrPercent };
  }

  /**
   * 개선: Box 손절 기록 (Same-box Loss Limiter용)
   */
  recordBoxLoss(symbol: string, boxId: string): void {
    const key = `${symbol}_${boxId}`;
    const existing = this.boxLossCount.get(key);
    const lossLimiter = (BOX_RANGE_CONFIG as any).sameBoxLossLimiter;

    if (existing) {
      existing.count++;
      existing.lastLossTime = Date.now();
    } else {
      this.boxLossCount.set(key, { count: 1, lastLossTime: Date.now() });
    }

    const current = this.boxLossCount.get(key)!;
    this.logger.log(
      `[BoxRangeSignal] ${symbol} Box loss recorded: count=${current.count}`,
      'BoxRangeSignal',
    );

    // 2회 손절 시 박스 비활성화
    if (lossLimiter?.enabled && current.count >= (lossLimiter?.maxConsecutiveLosses || 2)) {
      this.logger.warn(
        `[BoxRangeSignal] ${symbol} ❌ Same-box loss limit reached (${current.count}), invalidating box`,
        'BoxRangeSignal',
      );
      if (lossLimiter?.invalidateBox) {
        this.removeActiveBox(symbol);
      }
      this.disableSymbol(symbol, lossLimiter?.cooldownMinutes || 120, 'Same-box loss limit');
    }
  }

  /**
   * 개선: Viability Filter (TP 거리/스프레드)
   */
  private passesViabilityFilter(symbol: string, box: any, entryPrice: number, direction: string): boolean {
    const viabilityConfig = (BOX_RANGE_CONFIG as any).viabilityFilter;
    if (!viabilityConfig?.enabled) return true;

    const isMajor = viabilityConfig.majorSymbols?.includes(symbol) || false;

    // (A) TP 거리 최소값 필터
    const minTpDistanceConfig = viabilityConfig.minTpDistancePercent;
    const minTpDistance = isMajor ? minTpDistanceConfig?.major : minTpDistanceConfig?.altcoin;
    if (minTpDistance) {
      const tpDistance = direction === 'LONG'
        ? (box.upper - entryPrice) / entryPrice
        : (entryPrice - box.lower) / entryPrice;

      if (tpDistance < minTpDistance) {
        this.logger.debug(
          `[BoxRangeSignal] ${symbol} ❌ Viability: TP distance too small: ${(tpDistance * 100).toFixed(3)}% < ${(minTpDistance * 100).toFixed(3)}%`,
          'BoxRangeSignal',
        );
        return false;
      }
    }

    return true;
  }

  /**
   * Check upper timeframe filters
   */
  private async checkUpperTimeframeFilter(symbol: string): Promise<boolean> {
    const { h1 } = BOX_RANGE_CONFIG.upperTimeframeFilter;

    // Check 1H ADX
    const h1Candles = await this.dataCache.getRecentCandles(symbol, '1h', 24);
    if (!h1Candles || h1Candles.length < 14) {
      return true; // Can't check, allow
    }

    const { adx: h1Adx } = require('../../utils/indicators').Indicators.calculateAdx(h1Candles, 14);

    if (h1Adx > h1.maxAdx) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} ❌ 1H ADX too high: ${h1Adx.toFixed(2)} > ${h1.maxAdx} (strong trend detected)`,
        'BoxRangeSignal',
      );
      return false;
    }

    this.logger.debug(
      `[BoxRangeSignal] ${symbol} ✅ 1H ADX OK: ${h1Adx.toFixed(2)} <= ${h1.maxAdx}`,
      'BoxRangeSignal',
    );

    return true;
  }

  /**
   * Calculate risk/reward ratio
   */
  private calculateRiskReward(entrySignal: any): number {
    const risk = Math.abs(entrySignal.entryPrice - entrySignal.slPrice);
    const reward = Math.abs(entrySignal.tp2Price - entrySignal.entryPrice); // Use TP2 for R:R

    return reward / risk;
  }

  /**
   * Cleanup expired caches (call periodically)
   */
  cleanupCaches(): void {
    const now = Date.now();

    // Clean disabled symbols
    for (const [symbol, disabledUntil] of this.disabledSymbols.entries()) {
      if (now >= disabledUntil) {
        this.disabledSymbols.delete(symbol);
        this.logger.debug(
          `[BoxRangeSignal] ${symbol} Re-enabled (cooldown expired)`,
          'BoxRangeSignal',
        );
      }
    }

    // Clean stale boxes
    for (const [symbol, cached] of this.activeBoxes.entries()) {
      const cacheAge = now - cached.lastUpdated;
      if (cacheAge > 60 * 60 * 1000) {
        // 1 hour
        this.activeBoxes.delete(symbol);
        this.logger.debug(
          `[BoxRangeSignal] ${symbol} Stale box removed from cache`,
          'BoxRangeSignal',
        );
      }
    }
  }
}
