import { Injectable } from '@nestjs/common';
import { BOX_RANGE_CONFIG } from '../../constants/box-range.config';
import { Candle } from '../../interfaces/candle.interface';
import { BoxRange, SwingPoint, VolumeProfile, BoxGrade, BoxAgeStatus } from '../../interfaces/box.interface';
import { Indicators } from '../../utils/indicators';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Box Detector Service
 * Detects box ranges (consolidation patterns) in price action
 */
@Injectable()
export class BoxDetectorService {
  private readonly config = BOX_RANGE_CONFIG.boxDefinition;

  constructor(private readonly logger: CustomLoggerService) {}

  /**
   * Main box detection function
   */
  async detectBox(symbol: string, candles: Candle[]): Promise<BoxRange | null> {
    this.logger.debug(
      `[BoxDetector] ${symbol} Starting box detection with ${candles.length} candles`,
      'BoxDetector',
    );

    if (candles.length < 50) {
      this.logger.debug(
        `[BoxDetector] ${symbol} Insufficient candles: ${candles.length} < 50`,
        'BoxDetector',
      );
      return null;
    }

    // 1. Calculate ATR
    const atr = Indicators.calculateAtr(candles, 14);
    const currentPrice = candles[candles.length - 1].close;

    this.logger.debug(
      `[BoxDetector] ${symbol} ATR=${atr.toFixed(2)}, currentPrice=${currentPrice.toFixed(2)}`,
      'BoxDetector',
    );

    // 2. Find swing points
    const swingPoints = this.findSwingPoints(candles, this.config.swing.depth);
    const swingHighs = swingPoints.filter((p) => p.type === 'HIGH');
    const swingLows = swingPoints.filter((p) => p.type === 'LOW');

    this.logger.debug(
      `[BoxDetector] ${symbol} Swing points: highs=${swingHighs.length}, lows=${swingLows.length} ` +
        `(min: ${this.config.swing.minHighs}/${this.config.swing.minLows})`,
      'BoxDetector',
    );

    // 3. Minimum swing points validation
    if (
      swingHighs.length < this.config.swing.minHighs ||
      swingLows.length < this.config.swing.minLows
    ) {
      return null;
    }

    // 4. Calculate box boundaries (average of recent 3 swing points)
    const recentHighs = swingHighs.slice(-3);
    const recentLows = swingLows.slice(-3);

    const upper = this.average(recentHighs.map((p) => p.price));
    const lower = this.average(recentLows.map((p) => p.price));
    const height = upper - lower;
    const heightAtrRatio = height / atr;

    // Get symbol-specific height thresholds
    const heightThresholds = this.getSymbolHeightThresholds(symbol, atr, currentPrice);

    this.logger.debug(
      `[BoxDetector] ${symbol} Box boundaries: upper=${upper.toFixed(2)}, lower=${lower.toFixed(2)}, ` +
        `height=${height.toFixed(2)}, heightATR=${heightAtrRatio.toFixed(2)} ` +
        `(valid: ${heightThresholds.minAtr}-${heightThresholds.maxAtr}, type=${heightThresholds.type})`,
      'BoxDetector',
    );

    // 5. Swing point consistency validation with quality grading
    const highDeviation =
      Math.max(...recentHighs.map((p) => p.price)) -
      Math.min(...recentHighs.map((p) => p.price));
    const lowDeviation =
      Math.max(...recentLows.map((p) => p.price)) -
      Math.min(...recentLows.map((p) => p.price));

    const maxDeviationValue = Math.max(highDeviation, lowDeviation);

    // Use minimum absolute value to handle low ATR symbols fairly (relaxed from 0.03 to 0.06)
    const maxAllowedDeviation = Math.max(
      atr * this.config.swing.maxDeviationAtr,
      this.config.swing.minAbsoluteDeviation
    );

    // Quality grading based on deviation
    let swingQuality: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    if (maxDeviationValue <= this.config.swing.highQualityMaxDeviation) {
      swingQuality = 'HIGH';
    } else if (maxDeviationValue <= this.config.swing.mediumQualityMaxDeviation) {
      swingQuality = 'MEDIUM';
    }

    this.logger.debug(
      `[BoxDetector] ${symbol} Swing consistency: highDev=${highDeviation.toFixed(3)}, ` +
        `lowDev=${lowDeviation.toFixed(3)}, maxDev=${maxDeviationValue.toFixed(3)}, ` +
        `maxAllowed=${maxAllowedDeviation.toFixed(3)}, quality=${swingQuality}`,
      'BoxDetector',
    );

    if (maxDeviationValue > maxAllowedDeviation) {
      this.logger.debug(
        `[BoxDetector] ${symbol} ❌ Swing consistency FAILED: ${maxDeviationValue.toFixed(3)} > ${maxAllowedDeviation.toFixed(3)}`,
        'BoxDetector',
      );
      return null;
    }

    // Log quality upgrade
    if (swingQuality === 'HIGH') {
      this.logger.debug(
        `[BoxDetector] ${symbol} ⭐⭐ HIGH quality box: very tight swing consistency (${maxDeviationValue.toFixed(3)})`,
        'BoxDetector',
      );
    } else if (swingQuality === 'MEDIUM') {
      this.logger.debug(
        `[BoxDetector] ${symbol} ⭐ MEDIUM quality box: acceptable swing consistency (${maxDeviationValue.toFixed(3)})`,
        'BoxDetector',
      );
    }

    // 6. Box height validation (symbol-specific)
    if (heightAtrRatio < heightThresholds.minAtr || heightAtrRatio > heightThresholds.maxAtr) {
      this.logger.debug(
        `[BoxDetector] ${symbol} Height validation failed: ${heightAtrRatio.toFixed(2)} ATR ` +
          `(required: ${heightThresholds.minAtr}-${heightThresholds.maxAtr} for ${heightThresholds.type})`,
        'BoxDetector',
      );
      return null;
    }

    // 7. Count candles in box
    const candlesInBox = this.countCandlesInRange(candles, lower, upper);

    this.logger.debug(
      `[BoxDetector] ${symbol} Candles in box: ${candlesInBox} (min: ${this.config.time.minCandles})`,
      'BoxDetector',
    );

    if (candlesInBox < this.config.time.minCandles) {
      this.logger.debug(
        `[BoxDetector] ${symbol} ❌ Box too young: ${candlesInBox} candles < ${this.config.time.minCandles} (min 6h)`,
        'BoxDetector',
      );
      return null;
    }

    this.logger.debug(
      `[BoxDetector] ${symbol} ✅ Box age OK: ${candlesInBox} candles (${(candlesInBox * 15 / 60).toFixed(1)}h)`,
      'BoxDetector',
    );


    // 8. ADX validation (with slope filter)
    const { adx, plusDi, minusDi } = Indicators.calculateAdx(candles, 14);
    const diDiff = Math.abs(plusDi - minusDi);

    // Check ADX slope (must be declining)
    let adxSlope = 0;
    let adxDeclining = true;
    if (this.config.adx.requireDeclining && candles.length >= 14 + this.config.adx.slopeLookback) {
      const adxValues: number[] = [];
      for (let i = 0; i < this.config.adx.slopeLookback; i++) {
        const lookbackCandles = candles.slice(0, -(i));
        const { adx: historicalAdx } = Indicators.calculateAdx(lookbackCandles, 14);
        adxValues.push(historicalAdx);
      }
      adxValues.reverse(); // Oldest to newest
      adxValues.push(adx); // Current ADX

      // Calculate slope (simple linear)
      adxSlope = (adxValues[adxValues.length - 1] - adxValues[0]) / adxValues.length;
      adxDeclining = adxSlope <= 0;

      this.logger.debug(
        `[BoxDetector] ${symbol} ADX slope check: values=[${adxValues.map(v => v.toFixed(1)).join(', ')}], ` +
          `slope=${adxSlope.toFixed(3)}, declining=${adxDeclining}`,
        'BoxDetector',
      );
    }

    this.logger.debug(
      `[BoxDetector] ${symbol} ADX validation: adx=${adx.toFixed(2)} (max: ${this.config.adx.maxValue}), ` +
        `+DI=${plusDi.toFixed(2)}, -DI=${minusDi.toFixed(2)}, diff=${diDiff.toFixed(2)} (max: ${this.config.adx.maxDiDiff})`,
      'BoxDetector',
    );

    if (adx > this.config.adx.maxValue || diDiff > this.config.adx.maxDiDiff) {
      this.logger.debug(
        `[BoxDetector] ${symbol} ❌ ADX validation failed: adx=${adx.toFixed(2)} > ${this.config.adx.maxValue} or diDiff=${diDiff.toFixed(2)} > ${this.config.adx.maxDiDiff}`,
        'BoxDetector',
      );
      return null;
    }

    this.logger.debug(
      `[BoxDetector] ${symbol} ✅ ADX validation passed: adx=${adx.toFixed(2)} <= ${this.config.adx.maxValue}, diDiff=${diDiff.toFixed(2)} <= ${this.config.adx.maxDiDiff}`,
      'BoxDetector',
    );


    if (this.config.adx.requireDeclining && !adxDeclining) {
      this.logger.debug(
        `[BoxDetector] ${symbol} ADX is rising (slope=${adxSlope.toFixed(3)}), rejecting box`,
        'BoxDetector',
      );
      return null;
    }

    // 9. Volume profile validation
    const volumeProfile = this.analyzeVolumeProfile(candles, upper, lower);

    this.logger.debug(
      `[BoxDetector] ${symbol} Volume profile: centerAvg=${volumeProfile.centerAvg.toFixed(0)}, ` +
        `edgeAvg=${volumeProfile.edgeAvg.toFixed(0)}, valid=${volumeProfile.isValid}, ratio=${volumeProfile.ratio.toFixed(2)}`,
      'BoxDetector',
    );

    if (!volumeProfile.isValid) {
      this.logger.debug(
        `[BoxDetector] ${symbol} ❌ Volume profile invalid: centerAvg=${volumeProfile.centerAvg.toFixed(0)}, ` +
          `edgeAvg=${volumeProfile.edgeAvg.toFixed(0)}, ratio=${volumeProfile.ratio.toFixed(2)} ` +
          `(center should be > ${this.config.volume.centerRatio} of total)`,
        'BoxDetector',
      );
      return null;
    }

    this.logger.debug(
      `[BoxDetector] ${symbol} ✅ Volume profile valid: center concentration ${volumeProfile.ratio.toFixed(2)}`,
      'BoxDetector',
    );


    // 10. Calculate confidence (with height thresholds)
    const confidence = this.calculateConfidence(
      swingHighs.length + swingLows.length,
      adx,
      heightAtrRatio,
      candlesInBox,
      heightThresholds,
    );

    this.logger.debug(
      `[BoxDetector] ${symbol} Confidence score: ${confidence.toFixed(1)} ` +
        `(min: ${BOX_RANGE_CONFIG.boxGrade.rejectBelowConfidence})`,
      'BoxDetector',
    );

    // 11. Minimum confidence validation
    if (confidence < BOX_RANGE_CONFIG.boxGrade.rejectBelowConfidence) {
      this.logger.debug(
        `[BoxDetector] ${symbol} ❌ Confidence too low: ${confidence.toFixed(1)} < ${BOX_RANGE_CONFIG.boxGrade.rejectBelowConfidence}`,
        'BoxDetector',
      );
      return null;
    }

    this.logger.debug(
      `[BoxDetector] ${symbol} ✅ Confidence sufficient: ${confidence.toFixed(1)} >= ${BOX_RANGE_CONFIG.boxGrade.rejectBelowConfidence}`,
      'BoxDetector',
    );


    // 12. Determine box grade
    const grade = this.determineGrade(confidence);

    // 13. Determine box age status
    const ageStatus = this.determineAgeStatus(candlesInBox);

    const formationTime = candles[candles.length - candlesInBox]?.closeTime || Date.now();

    this.logger.log(
      `[BoxDetector] ${symbol} ✅ Box detected! Grade=${grade}, Quality=${swingQuality}, confidence=${confidence.toFixed(1)}, ` +
        `upper=${upper.toFixed(2)}, lower=${lower.toFixed(2)}, height=${height.toFixed(2)}, ` +
        `age=${candlesInBox} candles (${ageStatus}), touches=${swingHighs.length + swingLows.length}, ` +
        `swingDev=[high:${highDeviation.toFixed(3)}, low:${lowDeviation.toFixed(3)}]`,
      'BoxDetector',
    );

    return {
      symbol,
      upper,
      lower,
      height,
      heightAtrRatio,
      atr,
      swingHighs: recentHighs,
      swingLows: recentLows,
      formationTime,
      candlesInBox,
      adx,
      plusDi,
      minusDi,
      volumeProfile,
      confidence,
      grade,
      ageStatus,
      swingQuality,  // Quality grading: HIGH, MEDIUM, or LOW
      highDeviation, // High swing point deviation
      lowDeviation,  // Low swing point deviation
      maxDeviationValue, // Maximum deviation
      isValid: true,
    };
  }

  /**
   * Find swing points using ZigZag algorithm
   */
  private findSwingPoints(candles: Candle[], depth: number): SwingPoint[] {
    const points: SwingPoint[] = [];

    for (let i = depth; i < candles.length - depth; i++) {
      const current = candles[i];
      const leftCandles = candles.slice(i - depth, i);
      const rightCandles = candles.slice(i + 1, i + depth + 1);

      // Swing High: Higher than depth candles on both sides
      const isSwingHigh =
        leftCandles.every((c) => c.high <= current.high) &&
        rightCandles.every((c) => c.high <= current.high);

      if (isSwingHigh) {
        points.push({
          index: i,
          price: current.high,
          timestamp: current.closeTime,
          type: 'HIGH',
        });
      }

      // Swing Low: Lower than depth candles on both sides
      const isSwingLow =
        leftCandles.every((c) => c.low >= current.low) &&
        rightCandles.every((c) => c.low >= current.low);

      if (isSwingLow) {
        points.push({
          index: i,
          price: current.low,
          timestamp: current.closeTime,
          type: 'LOW',
        });
      }
    }

    return points;
  }

  /**
   * Count candles within box range
   */
  private countCandlesInRange(candles: Candle[], lower: number, upper: number): number {
    let count = 0;
    const tolerance = 0.005; // 0.5% tolerance

    for (let i = candles.length - 1; i >= 0; i--) {
      const candle = candles[i];
      const inRange =
        candle.high <= upper * (1 + tolerance) && candle.low >= lower * (1 - tolerance);

      if (inRange) {
        count++;
      } else if (count > 0) {
        break; // Stop counting once we exit the box
      }
    }

    return count;
  }

  /**
   * Analyze volume profile (center vs edges)
   */
  private analyzeVolumeProfile(candles: Candle[], upper: number, lower: number): VolumeProfile {
    const height = upper - lower;
    const center25 = lower + height * 0.25;
    const center75 = lower + height * 0.75;

    const centerVolumes: number[] = [];
    const edgeVolumes: number[] = [];

    const lookbackCandles = candles.slice(-this.config.volume.lookbackCandles);

    for (const candle of lookbackCandles) {
      const midPrice = (candle.high + candle.low) / 2;

      if (midPrice >= center25 && midPrice <= center75) {
        centerVolumes.push(candle.volume);
      } else if (midPrice >= lower && midPrice <= upper) {
        edgeVolumes.push(candle.volume);
      }
    }

    if (centerVolumes.length === 0 || edgeVolumes.length === 0) {
      return { centerAvg: 0, edgeAvg: 0, isValid: false, ratio: 0 };
    }

    const centerAvg = this.average(centerVolumes);
    const edgeAvg = this.average(edgeVolumes);
    const ratio = edgeAvg / centerAvg;

    // Valid if center volume is lower (consolidation) and edge volume is higher (tests)
    const isValid =
      centerAvg < edgeAvg * this.config.volume.centerRatio &&
      edgeAvg > centerAvg * this.config.volume.edgeRatio;

    return { centerAvg, edgeAvg, isValid, ratio };
  }

  /**
   * Calculate confidence score (0-100)
   */
  private calculateConfidence(
    touchCount: number,
    adx: number,
    heightAtrRatio: number,
    candlesInBox: number,
    heightThresholds: any,
  ): number {
    const weights = BOX_RANGE_CONFIG.confidence.weights;
    const scoring = BOX_RANGE_CONFIG.confidence.scoring;

    // 1. Touch count score (max 25)
    const touchScore = Math.min(touchCount * scoring.touch.perTouch, scoring.touch.max);

    // 2. ADX score (lower is better, max 25)
    let adxScore = 0;
    if (adx < 15) adxScore = scoring.adx.under15;
    else if (adx < 20) adxScore = scoring.adx.under20;
    else if (adx < 25) adxScore = scoring.adx.under25;

    // 3. Box height score (max 25) - use symbol-specific thresholds
    let heightScore = 0;
    if (
      heightAtrRatio >= heightThresholds.optimalMinAtr &&
      heightAtrRatio <= heightThresholds.optimalMaxAtr
    ) {
      heightScore = scoring.height.optimal;
    } else if (
      heightAtrRatio >= heightThresholds.minAtr &&
      heightAtrRatio <= heightThresholds.maxAtr
    ) {
      heightScore = scoring.height.acceptable;
    }

    // 4. Age score (max 25)
    let ageScore = 0;
    const ageHours = (candlesInBox * 15) / 60; // Convert 15m candles to hours
    if (ageHours >= 6 && ageHours <= 12) {
      ageScore = scoring.age.optimal; // 6-12 hours optimal
    } else if (ageHours >= 4 && ageHours <= 18) {
      ageScore = scoring.age.acceptable; // 4-18 hours acceptable
    } else if (ageHours >= 4) {
      ageScore = scoring.age.minimum; // 4+ hours minimum
    }

    const totalScore =
      touchScore * weights.touchCount +
      adxScore * weights.adxScore +
      heightScore * weights.boxHeightScore +
      ageScore * weights.ageScore;

    return totalScore;
  }

  /**
   * Determine box grade based on confidence
   */
  private determineGrade(confidence: number): BoxGrade {
    if (confidence >= BOX_RANGE_CONFIG.boxGrade.grades.A.minConfidence) {
      return 'A';
    } else if (confidence >= BOX_RANGE_CONFIG.boxGrade.grades.B.minConfidence) {
      return 'B';
    } else {
      return 'C';
    }
  }

  /**
   * Determine box age status
   */
  private determineAgeStatus(candlesInBox: number): BoxAgeStatus {
    if (candlesInBox < this.config.time.minCandles) {
      return 'FRESH';
    } else if (candlesInBox < this.config.time.warningCandles) {
      return 'OPTIMAL';
    } else if (candlesInBox < this.config.time.maxCandles) {
      return 'AGING';
    } else {
      return 'EXPIRED';
    }
  }

  /**
   * Calculate average of number array
   */
  private average(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    return numbers.reduce((a, b) => a + b, 0) / numbers.length;
  }

  /**
   * Get symbol-specific box height thresholds
   */
  private getSymbolHeightThresholds(symbol: string, atr: number, currentPrice: number): {
    minAtr: number;
    maxAtr: number;
    optimalMinAtr: number;
    optimalMaxAtr: number;
    type: string;
  } {
    const symbolTypes = BOX_RANGE_CONFIG.boxDefinition.symbolTypes;
    const atrPercent = atr / currentPrice;

    // 1. Check if stable coin (BTC, ETH)
    if (symbolTypes.stable.symbols.includes(symbol)) {
      return {
        ...symbolTypes.stable,
        type: 'STABLE',
      };
    }

    // 2. Check if high volatility (ATR% > 3%)
    if (atrPercent > 0.03) {
      return {
        ...symbolTypes.highVolatility,
        type: 'HIGH_VOLATILITY',
      };
    }

    // 3. Default to altcoin
    return {
      ...symbolTypes.altcoin,
      type: 'ALTCOIN',
    };
  }
}
