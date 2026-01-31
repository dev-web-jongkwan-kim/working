import { Candle } from '../interfaces';
import { calculateTrueRange } from './atr';

/**
 * ADX (Average Directional Index) result
 */
export interface ADXResult {
  adx: number;      // ADX value (0-100)
  plusDI: number;   // +DI value (0-100)
  minusDI: number;  // -DI value (0-100)
}

/**
 * Calculate +DM (Plus Directional Movement)
 */
function calculatePlusDM(current: Candle, previous: Candle): number {
  const upMove = current.high - previous.high;
  const downMove = previous.low - current.low;

  if (upMove > downMove && upMove > 0) {
    return upMove;
  }
  return 0;
}

/**
 * Calculate -DM (Minus Directional Movement)
 */
function calculateMinusDM(current: Candle, previous: Candle): number {
  const upMove = current.high - previous.high;
  const downMove = previous.low - current.low;

  if (downMove > upMove && downMove > 0) {
    return downMove;
  }
  return 0;
}

/**
 * Wilder's smoothing (exponential moving average with alpha = 1/period)
 */
function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 1 / period;

  // Initialize with SMA (average) of first 'period' values
  let smoothed = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  result.push(smoothed);

  // Apply Wilder's smoothing
  for (let i = period; i < values.length; i++) {
    smoothed = smoothed - smoothed * multiplier + values[i] * multiplier;
    result.push(smoothed);
  }

  return result;
}

/**
 * Calculate ADX (Average Directional Index)
 * Measures trend strength (not direction)
 *
 * @param candles Array of candles (oldest first)
 * @param period ADX period (typically 14)
 * @returns ADX result or null if insufficient data
 */
export function calculateADX(candles: Candle[], period: number): ADXResult | null {
  // Need at least period * 2 candles for reliable ADX
  if (candles.length < period * 2) {
    return null;
  }

  // Calculate TR, +DM, -DM for each candle
  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(calculateTrueRange(candles[i], candles[i - 1]));
    plusDMs.push(calculatePlusDM(candles[i], candles[i - 1]));
    minusDMs.push(calculateMinusDM(candles[i], candles[i - 1]));
  }

  // Apply Wilder's smoothing
  const smoothedTR = wilderSmooth(trueRanges, period);
  const smoothedPlusDM = wilderSmooth(plusDMs, period);
  const smoothedMinusDM = wilderSmooth(minusDMs, period);

  // Calculate +DI and -DI
  const plusDI: number[] = [];
  const minusDI: number[] = [];

  for (let i = 0; i < smoothedTR.length; i++) {
    if (smoothedTR[i] === 0) {
      plusDI.push(0);
      minusDI.push(0);
    } else {
      plusDI.push((smoothedPlusDM[i] / smoothedTR[i]) * 100);
      minusDI.push((smoothedMinusDM[i] / smoothedTR[i]) * 100);
    }
  }

  // Calculate DX
  const dx: number[] = [];
  for (let i = 0; i < plusDI.length; i++) {
    const sum = plusDI[i] + minusDI[i];
    if (sum === 0) {
      dx.push(0);
    } else {
      dx.push((Math.abs(plusDI[i] - minusDI[i]) / sum) * 100);
    }
  }

  // Calculate ADX (smoothed DX)
  if (dx.length < period) {
    return null;
  }

  const adxSmoothed = wilderSmooth(dx, period);
  const lastIndex = adxSmoothed.length - 1;

  return {
    adx: adxSmoothed[lastIndex],
    plusDI: plusDI[plusDI.length - 1],
    minusDI: minusDI[minusDI.length - 1],
  };
}

/**
 * Determine trend strength based on ADX value
 * @param adx ADX value
 * @returns Trend strength description
 */
export function getTrendStrength(adx: number): 'STRONG' | 'MODERATE' | 'WEAK' | 'ABSENT' {
  if (adx >= 40) return 'STRONG';
  if (adx >= 25) return 'MODERATE';
  if (adx >= 15) return 'WEAK';
  return 'ABSENT';
}

/**
 * Check if there is a strong trend
 * @param candles Array of candles
 * @param period ADX period
 * @param threshold Minimum ADX for "strong" trend (default: 25)
 * @returns true if strong trend, false otherwise
 */
export function hasStrongTrend(
  candles: Candle[],
  period: number,
  threshold: number = 25,
): boolean | null {
  const adxResult = calculateADX(candles, period);
  if (!adxResult) return null;

  return adxResult.adx >= threshold;
}

/**
 * Get trend direction based on +DI and -DI
 * @param candles Array of candles
 * @param period ADX period
 * @returns 'UP' | 'DOWN' | 'NEUTRAL' or null
 */
export function getTrendDirection(
  candles: Candle[],
  period: number,
): 'UP' | 'DOWN' | 'NEUTRAL' | null {
  const adxResult = calculateADX(candles, period);
  if (!adxResult) return null;

  const { plusDI, minusDI, adx } = adxResult;

  // No significant trend
  if (adx < 15) return 'NEUTRAL';

  // Determine direction from DI values
  if (plusDI > minusDI + 5) return 'UP';
  if (minusDI > plusDI + 5) return 'DOWN';

  return 'NEUTRAL';
}
