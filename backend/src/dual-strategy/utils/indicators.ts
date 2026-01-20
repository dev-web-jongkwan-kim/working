import { Candle } from '../interfaces/candle.interface';

export class Indicators {
  /**
   * Calculate ATR (Average True Range)
   */
  static calculateAtr(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) {
      return 0;
    }

    const trueRanges: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      );
      trueRanges.push(tr);
    }

    // Initial ATR (SMA)
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

    // EMA for subsequent values
    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  static calculateRsi(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) {
      return 50;
    }

    const changes = candles.slice(1).map((c, i) => c.close - candles[i].close);

    let avgGain = 0;
    let avgLoss = 0;

    // Initial average
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    // EMA for subsequent values
    for (let i = period; i < changes.length; i++) {
      const gain = changes[i] > 0 ? changes[i] : 0;
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  static calculateEma(values: number[], period: number): number[] {
    if (values.length < period) {
      return [];
    }

    const multiplier = 2 / (period + 1);
    const ema: number[] = [];

    // Initial SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    ema.push(sum / period);

    // EMA for subsequent values
    for (let i = period; i < values.length; i++) {
      ema.push((values[i] - ema[ema.length - 1]) * multiplier + ema[ema.length - 1]);
    }

    return ema;
  }

  /**
   * Calculate SMA (Simple Moving Average)
   */
  static calculateSma(values: number[], period: number): number[] {
    if (values.length < period) {
      return [];
    }

    const sma: number[] = [];
    for (let i = period - 1; i < values.length; i++) {
      const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }

    return sma;
  }

  /**
   * Calculate Bollinger Bands
   */
  static calculateBollingerBands(
    candles: Candle[],
    period: number = 20,
    stdDev: number = 2,
  ): { upper: number; middle: number; lower: number } {
    if (candles.length < period) {
      const lastClose = candles[candles.length - 1]?.close || 0;
      return { upper: lastClose, middle: lastClose, lower: lastClose };
    }

    const closes = candles.slice(-period).map((c) => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
    const std = Math.sqrt(variance);

    return {
      upper: sma + std * stdDev,
      middle: sma,
      lower: sma - std * stdDev,
    };
  }

  /**
   * Calculate Keltner Channel
   */
  static calculateKeltnerChannel(
    candles: Candle[],
    period: number = 20,
    atrMultiple: number = 1.5,
  ): { upper: number; middle: number; lower: number } {
    if (candles.length < period) {
      const lastClose = candles[candles.length - 1]?.close || 0;
      return { upper: lastClose, middle: lastClose, lower: lastClose };
    }

    const closes = candles.map((c) => c.close);
    const ema = this.calculateEma(closes, period);
    const middle = ema[ema.length - 1];
    const atr = this.calculateAtr(candles, period);

    return {
      upper: middle + atr * atrMultiple,
      middle,
      lower: middle - atr * atrMultiple,
    };
  }

  /**
   * Calculate CVD (Cumulative Volume Delta)
   * Approximates buying vs selling pressure
   */
  static calculateCvd(candles: Candle[]): number[] {
    const cvd: number[] = [];
    let cumulative = 0;

    for (const candle of candles) {
      const range = candle.high - candle.low;
      if (range === 0) {
        cvd.push(cumulative);
        continue;
      }

      // Approximate buy/sell volume based on close position in range
      const buyVolume = ((candle.close - candle.low) / range) * candle.volume;
      const sellVolume = ((candle.high - candle.close) / range) * candle.volume;
      cumulative += buyVolume - sellVolume;
      cvd.push(cumulative);
    }

    return cvd;
  }

  /**
   * Analyze CVD trend
   */
  static analyzeCvdTrend(cvdValues: number[]): 'RISING' | 'FALLING' | 'NEUTRAL' {
    if (cvdValues.length < 3) {
      return 'NEUTRAL';
    }

    const recent = cvdValues.slice(-3);
    const slope = (recent[2] - recent[0]) / 2;
    const avgValue = Math.abs(cvdValues[cvdValues.length - 1]);
    const slopePercent = avgValue > 0 ? slope / avgValue : 0;

    if (slopePercent > 0.02) return 'RISING';
    if (slopePercent < -0.02) return 'FALLING';
    return 'NEUTRAL';
  }

  /**
   * Find swing points (highs and lows)
   */
  static findSwingPoints(
    candles: Candle[],
    lookback: number = 5,
  ): { highs: number[]; lows: number[] } {
    const highs: number[] = [];
    const lows: number[] = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = i - lookback; j <= i + lookback; j++) {
        if (j !== i) {
          if (candles[j].high >= candles[i].high) isSwingHigh = false;
          if (candles[j].low <= candles[i].low) isSwingLow = false;
        }
      }

      if (isSwingHigh) highs.push(i);
      if (isSwingLow) lows.push(i);
    }

    return { highs, lows };
  }

  /**
   * Detect divergence between price and indicator
   */
  static detectDivergence(
    candles: Candle[],
    indicatorValues: number[],
    swingPoints: { highs: number[]; lows: number[] },
  ): {
    type: 'BULLISH' | 'BEARISH' | 'NONE';
    strength: number;
  } {
    const { highs, lows } = swingPoints;

    // Bullish divergence: price makes lower low, indicator makes higher low
    if (lows.length >= 2) {
      const lastLowIdx = lows[lows.length - 1];
      const prevLowIdx = lows[lows.length - 2];

      const priceLowerLow = candles[lastLowIdx].low < candles[prevLowIdx].low;
      const indicatorHigherLow =
        indicatorValues[lastLowIdx] > indicatorValues[prevLowIdx];

      if (priceLowerLow && indicatorHigherLow) {
        const priceDiff = Math.abs(
          (candles[lastLowIdx].low - candles[prevLowIdx].low) / candles[prevLowIdx].low,
        );
        const indDiff = Math.abs(
          (indicatorValues[lastLowIdx] - indicatorValues[prevLowIdx]) /
            indicatorValues[prevLowIdx],
        );
        return { type: 'BULLISH', strength: Math.min((priceDiff + indDiff) * 50, 100) };
      }
    }

    // Bearish divergence: price makes higher high, indicator makes lower high
    if (highs.length >= 2) {
      const lastHighIdx = highs[highs.length - 1];
      const prevHighIdx = highs[highs.length - 2];

      const priceHigherHigh = candles[lastHighIdx].high > candles[prevHighIdx].high;
      const indicatorLowerHigh =
        indicatorValues[lastHighIdx] < indicatorValues[prevHighIdx];

      if (priceHigherHigh && indicatorLowerHigh) {
        const priceDiff = Math.abs(
          (candles[lastHighIdx].high - candles[prevHighIdx].high) / candles[prevHighIdx].high,
        );
        const indDiff = Math.abs(
          (indicatorValues[lastHighIdx] - indicatorValues[prevHighIdx]) /
            indicatorValues[prevHighIdx],
        );
        return { type: 'BEARISH', strength: Math.min((priceDiff + indDiff) * 50, 100) };
      }
    }

    return { type: 'NONE', strength: 0 };
  }

  /**
   * Calculate standard deviation
   */
  static calculateStdDev(values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Calculate Z-score
   */
  static calculateZScore(value: number, values: number[]): number {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const stdDev = this.calculateStdDev(values);
    if (stdDev === 0) return 0;
    return (value - mean) / stdDev;
  }

  /**
   * Detect squeeze (Bollinger Bands inside Keltner Channel)
   */
  static detectSqueeze(
    candles: Candle[],
    bbPeriod: number = 20,
    bbStdDev: number = 2,
    kcPeriod: number = 20,
    kcAtrMultiple: number = 1.5,
  ): { inSqueeze: boolean; bars: number } {
    if (candles.length < Math.max(bbPeriod, kcPeriod)) {
      return { inSqueeze: false, bars: 0 };
    }

    let squeezeBars = 0;
    for (let i = candles.length - 1; i >= Math.max(bbPeriod, kcPeriod); i--) {
      const bb = this.calculateBollingerBands(candles.slice(0, i + 1), bbPeriod, bbStdDev);
      const kc = this.calculateKeltnerChannel(candles.slice(0, i + 1), kcPeriod, kcAtrMultiple);

      if (bb.upper < kc.upper && bb.lower > kc.lower) {
        squeezeBars++;
      } else {
        break;
      }
    }

    return {
      inSqueeze: squeezeBars > 0,
      bars: squeezeBars,
    };
  }

  /**
   * Calculate ADX (Average Directional Index)
   * Measures trend strength (0-100)
   * - ADX < 20: Weak trend / ranging market
   * - ADX 20-25: Moderate trend
   * - ADX > 25: Strong trend
   * - ADX > 50: Very strong trend
   */
  static calculateAdx(candles: Candle[], period: number = 14): {
    adx: number;
    plusDi: number;
    minusDi: number;
  } {
    if (candles.length < period + 1) {
      return { adx: 0, plusDi: 0, minusDi: 0 };
    }

    const plusDm: number[] = [];
    const minusDm: number[] = [];
    const tr: number[] = [];

    // Calculate +DM, -DM, and TR
    for (let i = 1; i < candles.length; i++) {
      const highDiff = candles[i].high - candles[i - 1].high;
      const lowDiff = candles[i - 1].low - candles[i].low;

      // +DM (Positive Directional Movement)
      if (highDiff > lowDiff && highDiff > 0) {
        plusDm.push(highDiff);
      } else {
        plusDm.push(0);
      }

      // -DM (Negative Directional Movement)
      if (lowDiff > highDiff && lowDiff > 0) {
        minusDm.push(lowDiff);
      } else {
        minusDm.push(0);
      }

      // TR (True Range)
      const trValue = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      );
      tr.push(trValue);
    }

    // Smooth +DM, -DM, and TR using Wilder's smoothing (like EMA with alpha = 1/period)
    let smoothedPlusDm = plusDm.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothedMinusDm = minusDm.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothedTr = tr.slice(0, period).reduce((a, b) => a + b, 0);

    for (let i = period; i < plusDm.length; i++) {
      smoothedPlusDm = smoothedPlusDm - smoothedPlusDm / period + plusDm[i];
      smoothedMinusDm = smoothedMinusDm - smoothedMinusDm / period + minusDm[i];
      smoothedTr = smoothedTr - smoothedTr / period + tr[i];
    }

    // Calculate +DI and -DI
    const plusDi = smoothedTr > 0 ? (smoothedPlusDm / smoothedTr) * 100 : 0;
    const minusDi = smoothedTr > 0 ? (smoothedMinusDm / smoothedTr) * 100 : 0;

    // Calculate DX (Directional Index)
    const diSum = plusDi + minusDi;
    const dx = diSum > 0 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0;

    // Calculate ADX (smoothed DX)
    // For simplicity, we use the current DX as ADX
    // In production, you'd want to smooth this over 'period' bars
    const adx = dx;

    return { adx, plusDi, minusDi };
  }

  /**
   * Calculate Relative Volume (RVol)
   * Compares current volume to average volume
   * - RVol > 1.5: High volume (significant interest)
   * - RVol 0.5-1.5: Normal volume
   * - RVol < 0.5: Low volume (lack of interest)
   */
  static calculateRVol(candles: Candle[], period: number = 20): {
    rvol: number;
    currentVolume: number;
    avgVolume: number;
  } {
    if (candles.length < period + 1) {
      return { rvol: 0, currentVolume: 0, avgVolume: 0 };
    }

    // Get last 'period' candles for average (excluding current candle)
    const historicalCandles = candles.slice(-period - 1, -1);
    const avgVolume = historicalCandles.reduce((sum, c) => sum + c.volume, 0) / period;

    // Current candle volume
    const currentVolume = candles[candles.length - 1].volume;

    // RVol = current volume / average volume
    const rvol = avgVolume > 0 ? currentVolume / avgVolume : 0;

    return { rvol, currentVolume, avgVolume };
  }
}
