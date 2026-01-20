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
 */
@Injectable()
export class BoxRangeSignalService {
  private activeBoxes: Map<string, ActiveBoxCache> = new Map();
  private disabledSymbols: Map<string, number> = new Map(); // symbol -> disabledUntil timestamp

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

    // 2. Check common filters
    if (!this.passesCommonFilters(candles, symbol)) {
      return { detected: false } as any;
    }

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

    // 6. Analyze entry conditions
    const entrySignal = await this.entryAnalyzer.analyzeEntry(box, candles, currentPrice, fundingRate);

    if (!entrySignal) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} ❌ No entry signal generated (check entry analyzer logs above for details)`,
        'BoxRangeSignal',
      );
      return { detected: false } as any;
    }

    // 7. Adjust position size based on swing quality
    let adjustedMarginUsd = entrySignal.marginUsd;
    let sizeAdjustmentReason = '';

    if (box.swingQuality === 'MEDIUM') {
      adjustedMarginUsd = entrySignal.marginUsd * 0.75; // 75% size for MEDIUM quality
      sizeAdjustmentReason = 'MEDIUM quality: 75% position size';
      this.logger.log(
        `[BoxRangeSignal] ${symbol} ⚠️ MEDIUM quality box detected - reducing position size to 75% ` +
          `(${entrySignal.marginUsd} → ${adjustedMarginUsd})`,
        'BoxRangeSignal',
      );
    } else if (box.swingQuality === 'HIGH') {
      sizeAdjustmentReason = 'HIGH quality: 100% position size';
      this.logger.log(
        `[BoxRangeSignal] ${symbol} ⭐⭐ HIGH quality box detected - full position size`,
        'BoxRangeSignal',
      );
    }

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
   */
  private passesCommonFilters(candles: Candle[], symbol: string): boolean {
    const { filters } = BOX_RANGE_CONFIG;

    // DEBUG: Log candle info
    this.logger.debug(
      `[BoxRangeSignal] ${symbol} Checking filters with ${candles.length} candles`,
      'BoxRangeSignal',
    );

    // DEBUG: Log first and last candle
    const firstCandle = candles[0];
    const lastCandle = candles[candles.length - 1];
    this.logger.debug(
      `[BoxRangeSignal] ${symbol} First candle: H=${firstCandle?.high} L=${firstCandle?.low} O=${firstCandle?.open} C=${firstCandle?.close}`,
      'BoxRangeSignal',
    );
    this.logger.debug(
      `[BoxRangeSignal] ${symbol} Last candle: H=${lastCandle?.high} L=${lastCandle?.low} O=${lastCandle?.open} C=${lastCandle?.close}`,
      'BoxRangeSignal',
    );

    // ATR filter
    const atr = require('../../utils/indicators').Indicators.calculateAtr(candles, 14);
    const currentPrice = candles[candles.length - 1].close;
    const atrPercent = atr / currentPrice;

    // DEBUG: Log ATR calculation details
    this.logger.debug(
      `[BoxRangeSignal] ${symbol} ATR=${atr.toFixed(8)}, Price=${currentPrice.toFixed(4)}, ATR%=${(atrPercent * 100).toFixed(2)}%`,
      'BoxRangeSignal',
    );

    if (atrPercent < filters.minAtrPercent || atrPercent > filters.maxAtrPercent) {
      this.logger.debug(
        `[BoxRangeSignal] ${symbol} Failed ATR filter: ${(atrPercent * 100).toFixed(2)}% ` +
          `(range: ${filters.minAtrPercent * 100}-${filters.maxAtrPercent * 100}%)`,
        'BoxRangeSignal',
      );
      return false;
    }

    // Additional filters could be added here (spread, volume rank)
    // For now, keeping it simple

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
