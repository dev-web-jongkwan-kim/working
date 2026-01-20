import { Candle } from '../interfaces/candle.interface';

export class CandleAnalyzer {
  /**
   * Count consecutive bars in the same direction (CRITICAL FILTER)
   * This is the core filter to avoid entering late in a trend
   */
  static countConsecutiveBars(candles: Candle[], direction: 'UP' | 'DOWN'): number {
    let count = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const isBullish = candles[i].close > candles[i].open;
      if (direction === 'UP' && isBullish) {
        count++;
      } else if (direction === 'DOWN' && !isBullish) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Calculate trend strength (0-1)
   * Returns direction and strength of the trend
   */
  static calculateTrendStrength(candles: Candle[]): {
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    strength: number;
  } {
    if (candles.length < 2) {
      return { direction: 'NEUTRAL', strength: 0 };
    }

    let higherHighs = 0;
    let higherLows = 0;
    let lowerHighs = 0;
    let lowerLows = 0;

    for (let i = 1; i < candles.length; i++) {
      if (candles[i].high > candles[i - 1].high) higherHighs++;
      if (candles[i].low > candles[i - 1].low) higherLows++;
      if (candles[i].high < candles[i - 1].high) lowerHighs++;
      if (candles[i].low < candles[i - 1].low) lowerLows++;
    }

    const total = (candles.length - 1) * 2;
    const upScore = (higherHighs + higherLows) / total;
    const downScore = (lowerHighs + lowerLows) / total;

    if (upScore > downScore && upScore > 0.3) {
      return { direction: 'UP', strength: upScore };
    } else if (downScore > upScore && downScore > 0.3) {
      return { direction: 'DOWN', strength: downScore };
    }

    return { direction: 'NEUTRAL', strength: 0 };
  }

  /**
   * Detect pullback state
   */
  static isPullback(
    candles: Candle[],
    trendDirection: 'UP' | 'DOWN',
    config: {
      minDepthAtr: number;
      maxDepthAtr: number;
      atr: number;
    },
  ): { isPullback: boolean; depth: number } {
    if (candles.length < 3) {
      return { isPullback: false, depth: 0 };
    }

    const recent = candles.slice(-3);
    const high = Math.max(...recent.map((c) => c.high));
    const low = Math.min(...recent.map((c) => c.low));
    const depth = (high - low) / config.atr;

    const lastCandle = candles[candles.length - 1];
    const isWeakening =
      trendDirection === 'UP'
        ? lastCandle.close < lastCandle.open
        : lastCandle.close > lastCandle.open;

    return {
      isPullback:
        isWeakening && depth >= config.minDepthAtr && depth <= config.maxDepthAtr,
      depth,
    };
  }

  /**
   * Detect reversal candle patterns
   */
  static detectReversalPattern(candles: Candle[]): {
    pattern: string | null;
    direction: 'BULLISH' | 'BEARISH' | null;
  } {
    if (candles.length < 3) {
      return { pattern: null, direction: null };
    }

    const [prev2, prev1, current] = candles.slice(-3);

    // Hammer
    const bodySize = Math.abs(current.close - current.open);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);

    if (
      prev1.close < prev1.open &&
      lowerWick >= bodySize * 2 &&
      upperWick <= bodySize * 0.3
    ) {
      return { pattern: 'HAMMER', direction: 'BULLISH' };
    }

    // Inverted Hammer
    if (
      prev1.close < prev1.open &&
      upperWick >= bodySize * 2 &&
      lowerWick <= bodySize * 0.3
    ) {
      return { pattern: 'INVERTED_HAMMER', direction: 'BULLISH' };
    }

    // Bullish Engulfing
    if (
      prev1.close < prev1.open &&
      current.close > current.open &&
      current.open <= prev1.close &&
      current.close >= prev1.open
    ) {
      return { pattern: 'BULLISH_ENGULFING', direction: 'BULLISH' };
    }

    // Bearish Engulfing
    if (
      prev1.close > prev1.open &&
      current.close < current.open &&
      current.open >= prev1.close &&
      current.close <= prev1.open
    ) {
      return { pattern: 'BEARISH_ENGULFING', direction: 'BEARISH' };
    }

    // Morning Star
    if (
      prev2.close < prev2.open &&
      Math.abs(prev1.close - prev1.open) < bodySize * 0.3 &&
      current.close > current.open &&
      current.close > (prev2.open + prev2.close) / 2
    ) {
      return { pattern: 'MORNING_STAR', direction: 'BULLISH' };
    }

    // Evening Star
    if (
      prev2.close > prev2.open &&
      Math.abs(prev1.close - prev1.open) < bodySize * 0.3 &&
      current.close < current.open &&
      current.close < (prev2.open + prev2.close) / 2
    ) {
      return { pattern: 'EVENING_STAR', direction: 'BEARISH' };
    }

    return { pattern: null, direction: null };
  }

  /**
   * Check if price is in a box range (consolidation)
   */
  static isInBoxRange(
    candles: Candle[],
    maxRangeAtr: number,
    atr: number,
  ): { inBox: boolean; boxHigh: number; boxLow: number; boxRange: number } {
    const boxHigh = Math.max(...candles.map((c) => c.high));
    const boxLow = Math.min(...candles.map((c) => c.low));
    const boxRange = boxHigh - boxLow;

    return {
      inBox: boxRange < atr * maxRangeAtr,
      boxHigh,
      boxLow,
      boxRange,
    };
  }

  /**
   * Count support/resistance tests
   */
  static countLevelTests(
    candles: Candle[],
    level: number,
    threshold: number,
    type: 'support' | 'resistance',
  ): number {
    let count = 0;
    for (const candle of candles) {
      if (type === 'support') {
        if (candle.low <= level * (1 + threshold) && candle.low >= level * (1 - threshold)) {
          count++;
        }
      } else {
        if (candle.high >= level * (1 - threshold) && candle.high <= level * (1 + threshold)) {
          count++;
        }
      }
    }
    return count;
  }
}
