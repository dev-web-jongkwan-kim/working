import { Candle } from '../interfaces';

/**
 * Calculate Simple Moving Average (SMA)
 * @param values Array of values
 * @param period SMA period
 * @returns SMA value or null if insufficient data
 */
function calculateSMA(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);
  return slice.reduce((sum, val) => sum + val, 0) / period;
}

/**
 * Calculate Standard Deviation
 * @param values Array of values
 * @param period Period for calculation
 * @returns Standard deviation or null if insufficient data
 */
function calculateStdDev(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);
  const mean = slice.reduce((sum, val) => sum + val, 0) / period;
  const squaredDiffs = slice.map((val) => Math.pow(val - mean, 2));
  const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / period;

  return Math.sqrt(variance);
}

/**
 * Bollinger Bands result
 */
export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  width: number;         // Absolute width (upper - lower)
  widthPercent: number;  // Width as percentage of middle ((upper - lower) / middle)
}

/**
 * Calculate Bollinger Bands
 * @param candles Array of candles (oldest first)
 * @param period BB period (typically 20)
 * @param stdDevMultiplier Standard deviation multiplier (typically 2.0)
 * @returns Bollinger Bands or null if insufficient data
 */
export function calculateBollingerBands(
  candles: Candle[],
  period: number,
  stdDevMultiplier: number = 2.0,
): BollingerBands | null {
  if (candles.length < period) {
    return null;
  }

  const closes = candles.map((c) => c.close);
  const middle = calculateSMA(closes, period);
  const stdDev = calculateStdDev(closes, period);

  if (middle === null || stdDev === null) {
    return null;
  }

  const upper = middle + stdDev * stdDevMultiplier;
  const lower = middle - stdDev * stdDevMultiplier;
  const width = upper - lower;
  const widthPercent = width / middle;

  return { upper, middle, lower, width, widthPercent };
}

/**
 * Calculate BB Width (normalized)
 * BBWidth = (Upper - Lower) / Middle
 * @param candles Array of candles
 * @param period BB period
 * @param stdDevMultiplier Standard deviation multiplier
 * @returns BB Width as percentage or null
 */
export function calculateBBWidth(
  candles: Candle[],
  period: number,
  stdDevMultiplier: number = 2.0,
): number | null {
  const bb = calculateBollingerBands(candles, period, stdDevMultiplier);
  return bb ? bb.widthPercent : null;
}

/**
 * Calculate BB Width series
 * @param candles Array of candles
 * @param period BB period
 * @param stdDevMultiplier Standard deviation multiplier
 * @returns Array of BB Width values (null for insufficient data)
 */
export function calculateBBWidthSeries(
  candles: Candle[],
  period: number,
  stdDevMultiplier: number = 2.0,
): (number | null)[] {
  const result: (number | null)[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const slice = candles.slice(0, i + 1);
    const bbWidth = calculateBBWidth(slice, period, stdDevMultiplier);
    result.push(bbWidth);
  }

  return result;
}

/**
 * Calculate BB Width percentile over a lookback period
 * Used to detect compression (low percentile = squeeze)
 * @param candles Array of candles
 * @param bbPeriod BB period
 * @param lookbackPeriod Number of BB Width values to consider for percentile
 * @param stdDevMultiplier Standard deviation multiplier
 * @returns Percentile (0-1) or null if insufficient data
 */
export function calculateBBWidthPercentile(
  candles: Candle[],
  bbPeriod: number,
  lookbackPeriod: number,
  stdDevMultiplier: number = 2.0,
): number | null {
  const bbWidthSeries = calculateBBWidthSeries(candles, bbPeriod, stdDevMultiplier);
  const validWidths = bbWidthSeries.filter((w): w is number => w !== null);

  if (validWidths.length < lookbackPeriod) {
    return null;
  }

  const recentWidths = validWidths.slice(-lookbackPeriod);
  const currentWidth = recentWidths[recentWidths.length - 1];
  const sortedWidths = [...recentWidths].sort((a, b) => a - b);

  // Find percentile rank
  const belowCount = sortedWidths.filter((w) => w < currentWidth).length;
  const equalCount = sortedWidths.filter((w) => w === currentWidth).length;

  // Percentile = (below + 0.5 * equal) / total
  const percentile = (belowCount + 0.5 * equalCount) / sortedWidths.length;

  return percentile;
}

/**
 * Detect BB compression (squeeze)
 * @param candles Array of candles
 * @param bbPeriod BB period
 * @param lookbackPeriod Lookback for percentile calculation
 * @param compressionThreshold Percentile threshold for compression (e.g., 0.15 = lowest 15%)
 * @returns true if compressed, false otherwise, null if insufficient data
 */
export function detectBBCompression(
  candles: Candle[],
  bbPeriod: number,
  lookbackPeriod: number,
  compressionThreshold: number = 0.15,
): boolean | null {
  const percentile = calculateBBWidthPercentile(candles, bbPeriod, lookbackPeriod);

  if (percentile === null) {
    return null;
  }

  return percentile <= compressionThreshold;
}

/**
 * Detect BB expansion (breakout from squeeze)
 * @param candles Array of candles (need at least 2 for comparison)
 * @param bbPeriod BB period
 * @param expansionThreshold Minimum increase in BB width to consider expansion
 * @returns true if expanding, false otherwise
 */
export function detectBBExpansion(
  candles: Candle[],
  bbPeriod: number,
  expansionThreshold: number = 0.1,
): boolean | null {
  if (candles.length < bbPeriod + 5) {
    return null;
  }

  const currentWidth = calculateBBWidth(candles, bbPeriod);
  const previousCandles = candles.slice(0, -1);
  const previousWidth = calculateBBWidth(previousCandles, bbPeriod);

  if (currentWidth === null || previousWidth === null) {
    return null;
  }

  // Check if width is expanding
  const widthIncrease = (currentWidth - previousWidth) / previousWidth;

  return widthIncrease >= expansionThreshold;
}
