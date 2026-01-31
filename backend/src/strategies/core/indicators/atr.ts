import { Candle } from '../interfaces';

/**
 * Calculate True Range for a single candle
 * TR = max(high - low, |high - prevClose|, |low - prevClose|)
 */
export function calculateTrueRange(current: Candle, previous: Candle): number {
  const highLow = current.high - current.low;
  const highPrevClose = Math.abs(current.high - previous.close);
  const lowPrevClose = Math.abs(current.low - previous.close);

  return Math.max(highLow, highPrevClose, lowPrevClose);
}

/**
 * Calculate Average True Range (ATR)
 * @param candles Array of candles (oldest first)
 * @param period ATR period (typically 14)
 * @returns ATR value or null if insufficient data
 */
export function calculateATR(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  // Calculate initial ATR using SMA of true ranges
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(calculateTrueRange(candles[i], candles[i - 1]));
  }

  // Use EMA-style smoothing for ATR (Wilder's smoothing)
  const multiplier = 1 / period;

  // Initialize ATR with SMA of first 'period' true ranges
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;

  // Calculate ATR using Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = atr * (1 - multiplier) + trueRanges[i] * multiplier;
  }

  return atr;
}

/**
 * Calculate ATR as percentage of current price
 * @param candles Array of candles
 * @param period ATR period
 * @returns ATR percentage (e.g., 0.02 = 2%) or null
 */
export function calculateATRPercent(candles: Candle[], period: number): number | null {
  const atr = calculateATR(candles, period);
  if (atr === null || candles.length === 0) {
    return null;
  }

  const currentPrice = candles[candles.length - 1].close;
  return atr / currentPrice;
}

/**
 * Calculate ATR series (all ATR values)
 * @param candles Array of candles (oldest first)
 * @param period ATR period
 * @returns Array of ATR values (null for insufficient data points)
 */
export function calculateATRSeries(candles: Candle[], period: number): (number | null)[] {
  const result: (number | null)[] = [];

  if (candles.length < period + 1) {
    return candles.map(() => null);
  }

  // Calculate all true ranges first
  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trueRanges.push(calculateTrueRange(candles[i], candles[i - 1]));
  }

  // Fill first 'period' values with null (insufficient data)
  for (let i = 0; i < period; i++) {
    result.push(null);
  }

  const multiplier = 1 / period;

  // Initialize ATR with SMA
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;
  result.push(atr);

  // Calculate ATR for remaining values using Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = atr * (1 - multiplier) + trueRanges[i] * multiplier;
    result.push(atr);
  }

  return result;
}

/**
 * Calculate stop loss price based on ATR
 * @param entryPrice Entry price
 * @param atr ATR value
 * @param multiplier ATR multiplier (e.g., 2.0)
 * @param direction Trade direction
 * @returns Stop loss price
 */
export function calculateATRStopLoss(
  entryPrice: number,
  atr: number,
  multiplier: number,
  direction: 'LONG' | 'SHORT',
): number {
  const stopDistance = atr * multiplier;

  if (direction === 'LONG') {
    return entryPrice - stopDistance;
  } else {
    return entryPrice + stopDistance;
  }
}

/**
 * Calculate take profit price based on risk-reward ratio
 * @param entryPrice Entry price
 * @param slPrice Stop loss price
 * @param riskRewardRatio Target R:R ratio (e.g., 1.0 for 1R)
 * @param direction Trade direction
 * @returns Take profit price
 */
export function calculateTakeProfit(
  entryPrice: number,
  slPrice: number,
  riskRewardRatio: number,
  direction: 'LONG' | 'SHORT',
): number {
  const risk = Math.abs(entryPrice - slPrice);
  const reward = risk * riskRewardRatio;

  if (direction === 'LONG') {
    return entryPrice + reward;
  } else {
    return entryPrice - reward;
  }
}
