import { Candle } from '../interfaces';

/**
 * Calculate Exponential Moving Average (EMA)
 * @param candles Array of candles (oldest first)
 * @param period EMA period
 * @returns EMA value or null if insufficient data
 */
export function calculateEMA(candles: Candle[], period: number): number | null {
  if (candles.length < period) {
    return null;
  }

  const closes = candles.map((c) => c.close);
  return calculateEMAFromValues(closes, period);
}

/**
 * Calculate EMA from price values
 * @param values Array of prices (oldest first)
 * @param period EMA period
 * @returns EMA value or null if insufficient data
 */
export function calculateEMAFromValues(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  // Initialize with SMA for first EMA value
  let ema = values.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  // Calculate EMA for remaining values
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Calculate EMA series (all EMA values for each candle)
 * @param candles Array of candles (oldest first)
 * @param period EMA period
 * @returns Array of EMA values (null for insufficient data points)
 */
export function calculateEMASeries(candles: Candle[], period: number): (number | null)[] {
  const closes = candles.map((c) => c.close);
  return calculateEMASeriesFromValues(closes, period);
}

/**
 * Calculate EMA series from values
 * @param values Array of prices (oldest first)
 * @param period EMA period
 * @returns Array of EMA values (null for insufficient data points)
 */
export function calculateEMASeriesFromValues(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];

  if (values.length < period) {
    return values.map(() => null);
  }

  const multiplier = 2 / (period + 1);

  // Fill first (period - 1) values with null
  for (let i = 0; i < period - 1; i++) {
    result.push(null);
  }

  // Initialize with SMA
  let ema = values.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  result.push(ema);

  // Calculate EMA for remaining values
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result.push(ema);
  }

  return result;
}

/**
 * Check if fast EMA is above slow EMA (bullish trend)
 * @param candles Array of candles
 * @param fastPeriod Fast EMA period (e.g., 50)
 * @param slowPeriod Slow EMA period (e.g., 200)
 * @returns true if bullish, false if bearish, null if insufficient data
 */
export function isEMABullish(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number,
): boolean | null {
  const fastEMA = calculateEMA(candles, fastPeriod);
  const slowEMA = calculateEMA(candles, slowPeriod);

  if (fastEMA === null || slowEMA === null) {
    return null;
  }

  return fastEMA > slowEMA;
}

/**
 * Detect EMA crossover
 * @param candles Array of candles (at least period + 1)
 * @param fastPeriod Fast EMA period
 * @param slowPeriod Slow EMA period
 * @returns 'BULLISH_CROSS' | 'BEARISH_CROSS' | null
 */
export function detectEMACrossover(
  candles: Candle[],
  fastPeriod: number,
  slowPeriod: number,
): 'BULLISH_CROSS' | 'BEARISH_CROSS' | null {
  if (candles.length < slowPeriod + 1) {
    return null;
  }

  const currentCandles = candles;
  const previousCandles = candles.slice(0, -1);

  const currentFastEMA = calculateEMA(currentCandles, fastPeriod);
  const currentSlowEMA = calculateEMA(currentCandles, slowPeriod);
  const previousFastEMA = calculateEMA(previousCandles, fastPeriod);
  const previousSlowEMA = calculateEMA(previousCandles, slowPeriod);

  if (!currentFastEMA || !currentSlowEMA || !previousFastEMA || !previousSlowEMA) {
    return null;
  }

  // Bullish crossover: fast crosses above slow
  if (previousFastEMA <= previousSlowEMA && currentFastEMA > currentSlowEMA) {
    return 'BULLISH_CROSS';
  }

  // Bearish crossover: fast crosses below slow
  if (previousFastEMA >= previousSlowEMA && currentFastEMA < currentSlowEMA) {
    return 'BEARISH_CROSS';
  }

  return null;
}
