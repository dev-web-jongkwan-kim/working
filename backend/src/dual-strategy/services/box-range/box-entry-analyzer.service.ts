import { Injectable } from '@nestjs/common';
import { BOX_RANGE_CONFIG } from '../../constants/box-range.config';
import { Candle } from '../../interfaces/candle.interface';
import { BoxRange, BoxEntrySignal, BoxEntryZone } from '../../interfaces/box.interface';
import { Indicators } from '../../utils/indicators';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Entry Analysis Options (2026-01-24 개선)
 * - LowVolMode: 저변동 구간에서 보수적 운영
 * - ExpandedBox: 4.5-6 ATR 확장 박스 조건부 운영
 */
export interface EntryAnalysisOptions {
  isLowVolMode?: boolean; // ATR% < 0.2% 저변동 모드
  isExpandedBox?: boolean; // 4.5-6 ATR 확장 박스
}

/**
 * Box Entry Analyzer Service
 * Analyzes entry conditions for box range trades
 */
@Injectable()
export class BoxEntryAnalyzerService {
  private readonly config = BOX_RANGE_CONFIG.entry;
  private readonly slTpConfig = BOX_RANGE_CONFIG.slTp;

  constructor(private readonly logger: CustomLoggerService) {}

  /**
   * Analyze entry conditions for a detected box
   * @param options - LowVolMode/ExpandedBox flags for conditional adjustments
   */
  async analyzeEntry(
    box: BoxRange,
    candles: Candle[],
    currentPrice: number,
    fundingRate: number,
    options: EntryAnalysisOptions = {},
  ): Promise<BoxEntrySignal | null> {
    const { symbol } = box;
    const { isLowVolMode = false, isExpandedBox = false } = options;

    // 모드별 로깅
    const modeFlags: string[] = [];
    if (isLowVolMode) modeFlags.push('LowVolMode');
    if (isExpandedBox) modeFlags.push('ExpandedBox');
    const modeStr = modeFlags.length > 0 ? ` [${modeFlags.join('+')}]` : '';

    this.logger.debug(
      `[BoxEntry] ${symbol}${modeStr} Analyzing entry for box (upper=${box.upper.toFixed(2)}, ` +
        `lower=${box.lower.toFixed(2)}, grade=${box.grade})`,
      'BoxEntryAnalyzer',
    );

    // 1. Check if price is in entry zone
    // ExpandedBox는 15% 진입존 (기본 20%)
    const entryZonePercent = isExpandedBox
      ? BOX_RANGE_CONFIG.boxDefinition.expandedBox.entryZonePercent
      : this.config.entryZonePercent;
    const entryZone = this.checkEntryZone(box, currentPrice, entryZonePercent);

    this.logger.debug(
      `[BoxEntry] ${symbol}${modeStr} Entry zone (${(entryZonePercent * 100).toFixed(0)}%): longZone=${entryZone.isInLongZone}, ` +
        `shortZone=${entryZone.isInShortZone}, distFromLower=${entryZone.distanceFromLowerPercent.toFixed(2)}%, ` +
        `distFromUpper=${entryZone.distanceFromUpperPercent.toFixed(2)}%`,
      'BoxEntryAnalyzer',
    );

    if (!entryZone.isInLongZone && !entryZone.isInShortZone) {
      this.logger.debug(
        `[BoxEntry] ${symbol} ❌ Not in entry zone (price=${currentPrice.toFixed(2)}, ` +
          `boxRange=${box.lower.toFixed(2)}-${box.upper.toFixed(2)}, ` +
          `longZone=${box.lower.toFixed(2)}-${(box.lower + box.height * this.config.entryZonePercent).toFixed(2)}, ` +
          `shortZone=${(box.upper - box.height * this.config.entryZonePercent).toFixed(2)}-${box.upper.toFixed(2)})`,
        'BoxEntryAnalyzer',
      );
      return null;
    }

    // 2. Calculate RSI
    const rsi = Indicators.calculateRsi(candles, 14);

    // 2a. Check RSI slope filter
    if (BOX_RANGE_CONFIG.entry.rsiSlopeFilter.enabled) {
      const rsiSlope = this.checkRsiSlope(candles, symbol);
      if (rsiSlope.isAggressive) {
        this.logger.debug(
          `[BoxEntry] ${symbol} RSI slope too aggressive (${rsiSlope.change.toFixed(1)} points), ` +
            `rejecting (breakout signal)`,
          'BoxEntryAnalyzer',
        );
        return null;
      }
    }

    // 3. Analyze current candle
    const currentCandle = candles[candles.length - 1];
    const candleType = this.analyzeCandleType(currentCandle);

    this.logger.debug(
      `[BoxEntry] ${symbol} RSI=${rsi.toFixed(2)}, candleType=${candleType}`,
      'BoxEntryAnalyzer',
    );

    // 4. Check for momentum decay
    const momentumDecay = this.checkMomentumDecay(candles, symbol);

    this.logger.debug(
      `[BoxEntry] ${symbol} Momentum decay: ${momentumDecay}`,
      'BoxEntryAnalyzer',
    );

    // 5. Check volume decay filter
    if (BOX_RANGE_CONFIG.entry.volumeDecayFilter.enabled) {
      const volumeCheck = this.checkVolumeDecay(candles, symbol);
      if (!volumeCheck.isDecaying) {
        this.logger.debug(
          `[BoxEntry] ${symbol} Volume not decaying (ratio=${volumeCheck.ratio.toFixed(2)}), ` +
            `rejecting (breakout signal)`,
          'BoxEntryAnalyzer',
        );
        return null;
      }
    }

    // 6. Check SFP filter
    if (BOX_RANGE_CONFIG.entry.sfpFilter.enabled) {
      const sfpCheck = this.checkSFPPattern(candles, box, entryZone, symbol);
      if (!sfpCheck.isValid) {
        this.logger.debug(
          `[BoxEntry] ${symbol} SFP filter: ${sfpCheck.reason}`,
          'BoxEntryAnalyzer',
        );
        return null;
      }
    }

    // 7. Check consecutive bars
    const consecutiveBars = this.countConsecutiveBars(candles);

    this.logger.debug(
      `[BoxEntry] ${symbol} Consecutive bars: ${consecutiveBars} (max: ${this.config.common.maxConsecutiveBars})`,
      'BoxEntryAnalyzer',
    );

    if (consecutiveBars > this.config.common.maxConsecutiveBars) {
      this.logger.debug(
        `[BoxEntry] ${symbol} ❌ Too many consecutive bars: ${consecutiveBars} > ${this.config.common.maxConsecutiveBars}`,
        'BoxEntryAnalyzer',
      );
      return null;
    }

    // 6. Determine direction and validate conditions
    let direction: 'LONG' | 'SHORT' | null = null;

    if (entryZone.isInLongZone) {
      // LONG entry conditions
      const rsiValid = rsi <= this.config.long.maxRsi;
      const candleValid = !this.config.long.requireBullishCandle || candleType === 'BULLISH';
      const momentumValid = !this.config.common.momentumDecay || momentumDecay;
      const breachPercent = Math.max(0, (box.lower - currentPrice) / box.lower);
      const breachValid = breachPercent <= this.config.long.maxBreachPercent;

      if (rsiValid && candleValid && momentumValid) {
        if (breachValid) {
          direction = 'LONG';

          this.logger.log(
            `[BoxEntry] ${symbol} ✅ LONG entry conditions met! RSI=${rsi.toFixed(2)}, ` +
              `candle=${candleType}, breach=${(breachPercent * 100).toFixed(3)}%`,
            'BoxEntryAnalyzer',
          );
        } else {
          this.logger.debug(
            `[BoxEntry] ${symbol} ❌ LONG breach too large: ${(breachPercent * 100).toFixed(3)}% > ${(this.config.long.maxBreachPercent * 100).toFixed(3)}%`,
            'BoxEntryAnalyzer',
          );
        }
      } else {
        this.logger.debug(
          `[BoxEntry] ${symbol} ❌ LONG conditions failed: RSI=${rsi.toFixed(2)} (need <=${this.config.long.maxRsi}): ${rsiValid ? '✅' : '❌'}, ` +
            `candle=${candleType} (need BULLISH): ${candleValid ? '✅' : '❌'}, ` +
            `momentum decay: ${momentumValid ? '✅' : '❌'}`,
          'BoxEntryAnalyzer',
        );
      }
    }

    if (entryZone.isInShortZone) {
      // SHORT entry conditions
      const rsiValid = rsi >= this.config.short.minRsi;
      const candleValid = !this.config.short.requireBearishCandle || candleType === 'BEARISH';
      const momentumValid = !this.config.common.momentumDecay || momentumDecay;
      const breachPercent = Math.max(0, (currentPrice - box.upper) / box.upper);
      const breachValid = breachPercent <= this.config.short.maxBreachPercent;

      if (rsiValid && candleValid && momentumValid) {
        if (breachValid) {
          direction = 'SHORT';

          this.logger.log(
            `[BoxEntry] ${symbol} ✅ SHORT entry conditions met! RSI=${rsi.toFixed(2)}, ` +
              `candle=${candleType}, breach=${(breachPercent * 100).toFixed(3)}%`,
            'BoxEntryAnalyzer',
          );
        } else {
          this.logger.debug(
            `[BoxEntry] ${symbol} ❌ SHORT breach too large: ${(breachPercent * 100).toFixed(3)}% > ${(this.config.short.maxBreachPercent * 100).toFixed(3)}%`,
            'BoxEntryAnalyzer',
          );
        }
      } else {
        this.logger.debug(
          `[BoxEntry] ${symbol} ❌ SHORT conditions failed: RSI=${rsi.toFixed(2)} (need >=${this.config.short.minRsi}): ${rsiValid ? '✅' : '❌'}, ` +
            `candle=${candleType} (need BEARISH): ${candleValid ? '✅' : '❌'}, ` +
            `momentum decay: ${momentumValid ? '✅' : '❌'}`,
          'BoxEntryAnalyzer',
        );
      }
    }

    if (!direction) {
      this.logger.debug(
        `[BoxEntry] ${symbol} ❌ No valid direction determined (checked LONG and SHORT conditions)`,
        'BoxEntryAnalyzer',
      );
      return null;
    }

    // 7. Apply funding bias
    const fundingAdjustedDirection = this.applyFundingBias(direction, fundingRate, symbol);

    if (!fundingAdjustedDirection) {
      this.logger.debug(
        `[BoxEntry] ${symbol} Signal rejected by funding bias (rate=${(fundingRate * 100).toFixed(4)}%)`,
        'BoxEntryAnalyzer',
      );
      return null;
    }

    direction = fundingAdjustedDirection;

    // 8. Check time filter
    if (!this.checkTimeFilter(box.grade, symbol)) {
      return null;
    }

    // 9. Calculate position sizing based on grade and age
    const gradeConfig = BOX_RANGE_CONFIG.boxGrade.grades[box.grade];
    const leverage = gradeConfig.leverage;
    let sizePercent = gradeConfig.sizePercent;

    // Age-based size reduction (18시간 넘으면 50% 축소)
    if (box.ageStatus === 'AGING') {
      sizePercent *= 0.5;
      this.logger.log(
        `[BoxEntry] ${symbol} Box is aging (${box.candlesInBox} candles), ` +
          `reducing size by 50% (${sizePercent}%)`,
        'BoxEntryAnalyzer',
      );
    }

    const marginUsd = BOX_RANGE_CONFIG.position.marginUsd * (sizePercent / 100);

    // 10. Calculate SL/TP prices (with POC-based TP1)
    // LowVolMode/ExpandedBox: TP 축소 적용
    const { slPrice, tp1Price, tp2Price, tp3Price, beTarget } = this.calculateSlTp(
      box,
      currentPrice,
      direction,
      candles,
      symbol,
      { isLowVolMode, isExpandedBox },
    );

    const modeInfo = isLowVolMode ? '[LowVol]' : isExpandedBox ? '[Expanded]' : '';
    this.logger.log(
      `[BoxEntry] ${symbol} 🎯 Signal generated!${modeInfo} Direction=${direction}, grade=${box.grade}, ` +
        `entry=${currentPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}, ` +
        `TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, BE=${beTarget}R, ` +
        `leverage=${leverage}x, margin=$${marginUsd.toFixed(2)}`,
      'BoxEntryAnalyzer',
    );

    return {
      detected: true,
      box,
      direction,
      entryPrice: currentPrice,
      slPrice,
      tp1Price,
      tp2Price,
      tp3Price: null, // No TP3 in 2-stage system
      rsi,
      candleType,
      momentumDecay,
      leverage,
      sizePercent,
      marginUsd,
      confidence: box.confidence,
      fundingRate,
      // 2026-01-24 개선: 모드별 조정 정보
      beTarget,
      isLowVolMode,
      isExpandedBox,
    };
  }

  /**
   * Check if price is in entry zone
   * @param entryZonePercent - 진입존 비율 (기본 20%, ExpandedBox 15%)
   */
  private checkEntryZone(
    box: BoxRange,
    currentPrice: number,
    entryZonePercent: number = this.config.entryZonePercent,
  ): BoxEntryZone {
    const entryZoneHeight = box.height * entryZonePercent;
    const longZoneUpper = box.lower + entryZoneHeight;
    const shortZoneLower = box.upper - entryZoneHeight;

    const isInLongZone = currentPrice >= box.lower && currentPrice <= longZoneUpper;
    const isInShortZone = currentPrice >= shortZoneLower && currentPrice <= box.upper;

    const distanceFromLower = currentPrice - box.lower;
    const distanceFromUpper = box.upper - currentPrice;

    return {
      isInLongZone,
      isInShortZone,
      distanceFromLower,
      distanceFromUpper,
      distanceFromLowerPercent: (distanceFromLower / box.height) * 100,
      distanceFromUpperPercent: (distanceFromUpper / box.height) * 100,
    };
  }

  /**
   * Analyze candle type
   */
  private analyzeCandleType(candle: Candle): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;

    // Require at least 40% body
    if (body / range < 0.4) {
      return 'NEUTRAL';
    }

    return candle.close > candle.open ? 'BULLISH' : 'BEARISH';
  }

  /**
   * Check for momentum decay (slowing down)
   */
  private checkMomentumDecay(candles: Candle[], symbol: string): boolean {
    const lookback = this.config.common.momentumLookback;
    if (candles.length < lookback * 2) {
      return false;
    }

    const recentCandles = candles.slice(-lookback);
    const previousCandles = candles.slice(-lookback * 2, -lookback);

    // Calculate average candle body size
    const recentAvgBody =
      recentCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / lookback;
    const previousAvgBody =
      previousCandles.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / lookback;

    const decay = recentAvgBody < previousAvgBody;

    this.logger.debug(
      `[BoxEntry] ${symbol} Momentum decay check: recentAvg=${recentAvgBody.toFixed(2)}, ` +
        `previousAvg=${previousAvgBody.toFixed(2)}, decay=${decay}`,
      'BoxEntryAnalyzer',
    );

    return decay;
  }

  /**
   * Count consecutive same-direction bars
   */
  private countConsecutiveBars(candles: Candle[]): number {
    if (candles.length < 2) return 0;

    const lastCandle = candles[candles.length - 1];
    const lastDirection = lastCandle.close > lastCandle.open ? 'UP' : 'DOWN';

    let count = 1;
    for (let i = candles.length - 2; i >= 0; i--) {
      const candle = candles[i];
      const direction = candle.close > candle.open ? 'UP' : 'DOWN';

      if (direction === lastDirection) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * Apply funding bias to direction
   */
  private applyFundingBias(
    direction: 'LONG' | 'SHORT',
    fundingRate: number,
    symbol: string,
  ): 'LONG' | 'SHORT' | null {
    if (!BOX_RANGE_CONFIG.fundingBias.enabled) {
      return direction;
    }

    const { threshold, extremeThreshold } = BOX_RANGE_CONFIG.fundingBias;

    // Extreme funding: only trade in favorable direction
    if (Math.abs(fundingRate) >= extremeThreshold) {
      if (fundingRate > 0 && direction === 'LONG') {
        this.logger.debug(
          `[BoxEntry] ${symbol} Extreme positive funding (${(fundingRate * 100).toFixed(4)}%), rejecting LONG`,
          'BoxEntryAnalyzer',
        );
        return null; // Don't long when funding extremely positive
      }
      if (fundingRate < 0 && direction === 'SHORT') {
        this.logger.debug(
          `[BoxEntry] ${symbol} Extreme negative funding (${(fundingRate * 100).toFixed(4)}%), rejecting SHORT`,
          'BoxEntryAnalyzer',
        );
        return null; // Don't short when funding extremely negative
      }
    }

    // Moderate funding: prefer favorable direction
    if (fundingRate >= threshold && direction === 'LONG') {
      this.logger.debug(
        `[BoxEntry] ${symbol} Positive funding bias (${(fundingRate * 100).toFixed(4)}%), prefer SHORT over LONG`,
        'BoxEntryAnalyzer',
      );
      // Could reject LONG or just log warning - for now, allow but log
    }
    if (fundingRate <= -threshold && direction === 'SHORT') {
      this.logger.debug(
        `[BoxEntry] ${symbol} Negative funding bias (${(fundingRate * 100).toFixed(4)}%), prefer LONG over SHORT`,
        'BoxEntryAnalyzer',
      );
      // Could reject SHORT or just log warning - for now, allow but log
    }

    return direction;
  }

  /**
   * Check time filter based on grade
   */
  private checkTimeFilter(grade: 'A' | 'B' | 'C', symbol: string): boolean {
    if (!BOX_RANGE_CONFIG.timeFilter.enabled) {
      return true;
    }

    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const kstHourDecimal = ((utcHour + 9) % 24) + (utcMinute / 60); // KST with decimal

    // Check NY session disabled hours (21:30-23:30 KST)
    const { start: disabledStart, end: disabledEnd } = BOX_RANGE_CONFIG.timeFilter.disabledHours;

    // Handle decimal hours (21.5 = 21:30)
    if (kstHourDecimal >= disabledStart && kstHourDecimal < disabledEnd) {
      this.logger.debug(
        `[BoxEntry] ${symbol} NY session filter: current=${kstHourDecimal.toFixed(2)} KST, ` +
          `disabled=${disabledStart}-${disabledEnd} (high breakout risk)`,
        'BoxEntryAnalyzer',
      );
      return false;
    }

    // Check grade-specific hours
    const gradeConfig = BOX_RANGE_CONFIG.boxGrade.grades[grade];
    const { start, end } = gradeConfig.allowedHours;
    const kstHour = Math.floor(kstHourDecimal); // Integer hour for grade check

    if (kstHour < start || kstHour >= end) {
      this.logger.debug(
        `[BoxEntry] ${symbol} Outside grade ${grade} hours (current: ${kstHour} KST, allowed: ${start}-${end})`,
        'BoxEntryAnalyzer',
      );
      return false;
    }

    return true;
  }

  /**
   * Calculate SL/TP prices (2-stage system with POC-based TP1)
   * @param options - LowVolMode/ExpandedBox flags for TP adjustment
   *
   * 2026-01-24 개선:
   * - LowVolMode: TP 0.6R, BE 0.4R (보수적)
   * - ExpandedBox: TP 0.7R (중간)
   * - Normal: TP 0.5R (기존)
   */
  private calculateSlTp(
    box: BoxRange,
    entryPrice: number,
    direction: 'LONG' | 'SHORT',
    candles: Candle[],
    symbol: string,
    options: EntryAnalysisOptions = {},
  ): {
    slPrice: number;
    tp1Price: number;
    tp2Price: number;
    tp3Price: number;
    beTarget: number; // BE 이동 목표 (R 배수)
  } {
    const { isLowVolMode = false, isExpandedBox = false } = options;
    const slBuffer = box.atr * this.slTpConfig.slBufferAtr;

    let slPrice: number;
    let tp1Price: number;
    let tp2Price: number;

    // TP1 비율 결정 (LowVolMode > ExpandedBox > Normal)
    // LowVolMode: 0.6R, ExpandedBox: 0.7R, Normal: 기존 fallbackPercent (0.5)
    let tp1Ratio = this.slTpConfig.tp1.fallbackPercent;
    let tp2Ratio = this.slTpConfig.tp2.targetPercent;
    let beTarget = 0.5; // 기본 BE 이동 목표

    if (isLowVolMode) {
      tp1Ratio = BOX_RANGE_CONFIG.lowVolMode.adjustments.tp1Ratio; // 0.6R
      tp2Ratio = 0.7; // 축소된 TP2
      beTarget = BOX_RANGE_CONFIG.lowVolMode.adjustments.beActivateRatio; // 0.4R
      this.logger.debug(
        `[BoxEntry] ${symbol} LowVolMode: TP1=${tp1Ratio}R, TP2=${tp2Ratio}R, BE=${beTarget}R`,
        'BoxEntryAnalyzer',
      );
    } else if (isExpandedBox) {
      tp1Ratio = BOX_RANGE_CONFIG.boxDefinition.expandedBox.tpRatio; // 0.7R
      tp2Ratio = 0.85; // 약간 축소된 TP2
      beTarget = 0.45; // 약간 빠른 BE
      this.logger.debug(
        `[BoxEntry] ${symbol} ExpandedBox: TP1=${tp1Ratio}R, TP2=${tp2Ratio}R, BE=${beTarget}R`,
        'BoxEntryAnalyzer',
      );
    }

    // Calculate POC (Point of Control) from volume profile
    let pocPrice = null;
    if (this.slTpConfig.tp1.usePOC && box.volumeProfile) {
      pocPrice = this.calculatePOC(candles, box);
    }

    if (direction === 'LONG') {
      // SL below box lower
      slPrice = box.lower - slBuffer;

      // TP1: Use POC if available and valid, otherwise use mode-based ratio
      if (pocPrice && pocPrice > entryPrice && pocPrice < box.upper && !isLowVolMode && !isExpandedBox) {
        // POC는 normal 모드에서만 사용 (LowVolMode/ExpandedBox에서는 고정 비율 사용)
        tp1Price = pocPrice;
        this.logger.debug(
          `[BoxEntry] ${symbol} TP1 using POC: ${pocPrice.toFixed(2)}`,
          'BoxEntryAnalyzer',
        );
      } else {
        tp1Price = entryPrice + box.height * tp1Ratio;
        this.logger.debug(
          `[BoxEntry] ${symbol} TP1 using ratio (${tp1Ratio * 100}%): ${tp1Price.toFixed(2)}`,
          'BoxEntryAnalyzer',
        );
      }

      // TP2: mode-based ratio
      tp2Price = entryPrice + box.height * tp2Ratio;
    } else {
      // SHORT
      // SL above box upper
      slPrice = box.upper + slBuffer;

      // TP1: Use POC if available and valid, otherwise use mode-based ratio
      if (pocPrice && pocPrice < entryPrice && pocPrice > box.lower && !isLowVolMode && !isExpandedBox) {
        tp1Price = pocPrice;
        this.logger.debug(
          `[BoxEntry] ${symbol} TP1 using POC: ${pocPrice.toFixed(2)}`,
          'BoxEntryAnalyzer',
        );
      } else {
        tp1Price = entryPrice - box.height * tp1Ratio;
        this.logger.debug(
          `[BoxEntry] ${symbol} TP1 using ratio (${tp1Ratio * 100}%): ${tp1Price.toFixed(2)}`,
          'BoxEntryAnalyzer',
        );
      }

      // TP2: mode-based ratio
      tp2Price = entryPrice - box.height * tp2Ratio;
    }

    const modeStr = isLowVolMode ? '[LowVol]' : isExpandedBox ? '[Expanded]' : '[Normal]';
    this.logger.debug(
      `[BoxEntry] ${symbol} ${modeStr} SL/TP calculation: direction=${direction}, ` +
        `boxHeight=${box.height.toFixed(2)}, slBuffer=${slBuffer.toFixed(2)}, ` +
        `TP1=${tp1Price.toFixed(2)} (${tp1Ratio}R), ` +
        `TP2=${tp2Price.toFixed(2)} (${tp2Ratio}R), BE target=${beTarget}R`,
      'BoxEntryAnalyzer',
    );

    return { slPrice, tp1Price, tp2Price, tp3Price: null, beTarget };
  }

  /**
   * Check RSI slope (detect aggressive breakouts)
   */
  private checkRsiSlope(candles: Candle[], symbol: string): { isAggressive: boolean; change: number } {
    const config = BOX_RANGE_CONFIG.entry.rsiSlopeFilter;
    const lookback = config.lookbackCandles;

    if (candles.length < 14 + lookback) {
      return { isAggressive: false, change: 0 };
    }

    // Calculate RSI for last N candles
    const rsiValues: number[] = [];
    for (let i = 0; i < lookback + 1; i++) {
      const slicedCandles = candles.slice(0, -(i === 0 ? 0 : i));
      const rsi = Indicators.calculateRsi(slicedCandles, 14);
      rsiValues.push(rsi);
    }
    rsiValues.reverse(); // Oldest to newest

    // Calculate max change
    const maxChange = Math.max(...rsiValues) - Math.min(...rsiValues);
    const isAggressive = maxChange > config.maxChange;

    return { isAggressive, change: maxChange };
  }

  /**
   * Check volume decay (support/resistance working)
   */
  private checkVolumeDecay(candles: Candle[], symbol: string): { isDecaying: boolean; ratio: number } {
    const config = BOX_RANGE_CONFIG.entry.volumeDecayFilter;
    const lookback = config.lookbackCandles;

    if (candles.length < lookback + 1) {
      return { isDecaying: true, ratio: 0 }; // Allow if insufficient data
    }

    const currentVolume = candles[candles.length - 1].volume;
    const historicalCandles = candles.slice(-(lookback + 1), -1);
    const avgVolume = historicalCandles.reduce((sum, c) => sum + c.volume, 0) / lookback;

    const ratio = currentVolume / avgVolume;
    const isDecaying = ratio <= config.maxVolumeRatio;

    return { isDecaying, ratio };
  }

  /**
   * Check SFP (Sweep/Fake Breakout) pattern
   */
  private checkSFPPattern(
    candles: Candle[],
    box: BoxRange,
    entryZone: any,
    symbol: string,
  ): { isValid: boolean; reason: string } {
    const config = BOX_RANGE_CONFIG.entry.sfpFilter;

    if (candles.length < config.returnCandleCount + 1) {
      return { isValid: true, reason: 'Insufficient candles for SFP check' };
    }

    // Check last N candles for breach + return pattern
    const recentCandles = candles.slice(-(config.returnCandleCount + 1));
    let foundBreach = false;
    let foundReturn = false;

    for (let i = 0; i < recentCandles.length - 1; i++) {
      const candle = recentCandles[i];
      const nextCandle = recentCandles[i + 1];

      // Check for breach below box (for LONG entry)
      if (entryZone.isInLongZone) {
        const breachPercent = Math.max(0, (box.lower - candle.low) / box.lower);
        if (breachPercent >= config.minBreachPercent && breachPercent <= config.maxBreachPercent) {
          foundBreach = true;

          // Check if price returned inside box
          if (nextCandle.close > box.lower && nextCandle.close < box.upper) {
            foundReturn = true;
          }
        }
      }

      // Check for breach above box (for SHORT entry)
      if (entryZone.isInShortZone) {
        const breachPercent = Math.max(0, (candle.high - box.upper) / box.upper);
        if (breachPercent >= config.minBreachPercent && breachPercent <= config.maxBreachPercent) {
          foundBreach = true;

          // Check if price returned inside box
          if (nextCandle.close < box.upper && nextCandle.close > box.lower) {
            foundReturn = true;
          }
        }
      }
    }

    // If SFP required but not found, allow simple touch entry
    if (config.requireReturn && !foundReturn) {
      // Simple touch is also valid, not requiring SFP
      return { isValid: true, reason: 'Simple touch entry (no SFP required)' };
    }

    return { isValid: true, reason: foundBreach && foundReturn ? 'Valid SFP pattern' : 'Simple touch entry' };
  }

  /**
   * Calculate POC (Point of Control) from volume profile
   */
  private calculatePOC(candles: Candle[], box: BoxRange): number | null {
    // Analyze volume distribution within box range
    const priceStep = box.height / 20; // Divide box into 20 price levels
    const volumeByPrice: Map<number, number> = new Map();

    // Look at recent candles within box
    const boxCandles = candles.filter((c) => {
      const midPrice = (c.high + c.low) / 2;
      return midPrice >= box.lower && midPrice <= box.upper;
    });

    if (boxCandles.length < 10) {
      return null; // Insufficient data
    }

    // Accumulate volume per price level
    for (const candle of boxCandles) {
      const priceLevel = Math.floor(((candle.high + candle.low) / 2 - box.lower) / priceStep);
      const currentVolume = volumeByPrice.get(priceLevel) || 0;
      volumeByPrice.set(priceLevel, currentVolume + candle.volume);
    }

    // Find price level with highest volume (POC)
    let maxVolume = 0;
    let pocLevel = 0;

    for (const [level, volume] of volumeByPrice.entries()) {
      if (volume > maxVolume) {
        maxVolume = volume;
        pocLevel = level;
      }
    }

    // Convert level back to price
    const pocPrice = box.lower + (pocLevel + 0.5) * priceStep;

    return pocPrice;
  }
}
