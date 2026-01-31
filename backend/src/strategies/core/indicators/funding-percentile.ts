/**
 * Funding rate percentile calculation
 * Used by Funding Overlay to determine ALLOW/TIGHTEN/BLOCK actions
 */

/**
 * Funding overlay action based on percentile
 */
export type FundingOverlayAction = 'ALLOW' | 'TIGHTEN' | 'BLOCK';

/**
 * Funding analysis result
 */
export interface FundingAnalysis {
  currentRate: number;
  percentile: number;      // 0-1, where 0.9+ is extremely high, 0.1- is extremely low
  action: FundingOverlayAction;
  isExtreme: boolean;
  direction: 'HIGH' | 'LOW' | 'NORMAL';
}

/**
 * Calculate funding rate percentile
 * @param currentRate Current funding rate
 * @param historicalRates Historical funding rates (oldest first)
 * @returns Percentile (0-1) or null if insufficient data
 */
export function calculateFundingPercentile(
  currentRate: number,
  historicalRates: number[],
): number | null {
  if (historicalRates.length === 0) {
    return null;
  }

  const sortedRates = [...historicalRates].sort((a, b) => a - b);
  const belowCount = sortedRates.filter((r) => r < currentRate).length;
  const equalCount = sortedRates.filter((r) => r === currentRate).length;

  // Percentile = (below + 0.5 * equal) / total
  const percentile = (belowCount + 0.5 * equalCount) / sortedRates.length;

  return percentile;
}

/**
 * Analyze funding rate for trading decision
 * @param currentRate Current funding rate
 * @param historicalRates Historical funding rates
 * @param highPercentile Threshold for "high" funding (default: 0.9)
 * @param lowPercentile Threshold for "low" funding (default: 0.1)
 * @param blockOnExtreme Whether to block trades on extreme funding (default: false)
 * @returns Funding analysis result or null
 */
export function analyzeFunding(
  currentRate: number,
  historicalRates: number[],
  highPercentile: number = 0.9,
  lowPercentile: number = 0.1,
  blockOnExtreme: boolean = false,
): FundingAnalysis | null {
  const percentile = calculateFundingPercentile(currentRate, historicalRates);

  if (percentile === null) {
    return null;
  }

  let direction: 'HIGH' | 'LOW' | 'NORMAL' = 'NORMAL';
  let isExtreme = false;
  let action: FundingOverlayAction = 'ALLOW';

  if (percentile >= highPercentile) {
    // High funding (many longs paying shorts)
    direction = 'HIGH';
    isExtreme = true;
    action = blockOnExtreme ? 'BLOCK' : 'TIGHTEN';
  } else if (percentile <= lowPercentile) {
    // Low/negative funding (shorts paying longs)
    direction = 'LOW';
    isExtreme = true;
    action = blockOnExtreme ? 'BLOCK' : 'TIGHTEN';
  }

  return {
    currentRate,
    percentile,
    action,
    isExtreme,
    direction,
  };
}

/**
 * Determine if funding conditions are favorable for a direction
 * @param currentRate Current funding rate
 * @param historicalRates Historical funding rates
 * @param tradeDirection Intended trade direction
 * @param highPercentile High funding threshold
 * @param lowPercentile Low funding threshold
 * @returns Whether funding is favorable for the direction
 */
export function isFundingFavorable(
  currentRate: number,
  historicalRates: number[],
  tradeDirection: 'LONG' | 'SHORT',
  highPercentile: number = 0.9,
  lowPercentile: number = 0.1,
): boolean | null {
  const analysis = analyzeFunding(currentRate, historicalRates, highPercentile, lowPercentile);

  if (!analysis) {
    return null;
  }

  // High funding is unfavorable for LONG (paying funding)
  // Low funding is unfavorable for SHORT (paying funding)
  if (tradeDirection === 'LONG') {
    // Avoid entering long when funding is extremely high
    return analysis.direction !== 'HIGH';
  } else {
    // Avoid entering short when funding is extremely low/negative
    return analysis.direction !== 'LOW';
  }
}

/**
 * Calculate position tightening parameters based on funding
 * @param fundingAnalysis Funding analysis result
 * @param baseTp1QtyPercent Base TP1 quantity percentage
 * @param baseTrailAtrMult Base trailing ATR multiplier
 * @param tightenTp1Add Amount to add to TP1 qty when tightening
 * @param tightenTrailSub Amount to subtract from trail ATR when tightening
 * @returns Adjusted parameters
 */
export function adjustForFunding(
  fundingAnalysis: FundingAnalysis,
  baseTp1QtyPercent: number,
  baseTrailAtrMult: number,
  tightenTp1Add: number = 0.1,
  tightenTrailSub: number = 0.3,
): { tp1QtyPercent: number; trailAtrMult: number } {
  if (fundingAnalysis.action === 'TIGHTEN') {
    return {
      tp1QtyPercent: Math.min(baseTp1QtyPercent + tightenTp1Add, 0.5), // Cap at 50%
      trailAtrMult: Math.max(baseTrailAtrMult - tightenTrailSub, 1.5), // Min 1.5x ATR
    };
  }

  return {
    tp1QtyPercent: baseTp1QtyPercent,
    trailAtrMult: baseTrailAtrMult,
  };
}

/**
 * Calculate z-score for funding rate
 * @param currentRate Current funding rate
 * @param historicalRates Historical funding rates
 * @returns Z-score or null if insufficient data
 */
export function calculateFundingZScore(
  currentRate: number,
  historicalRates: number[],
): number | null {
  if (historicalRates.length < 10) {
    return null;
  }

  const mean = historicalRates.reduce((sum, r) => sum + r, 0) / historicalRates.length;
  const squaredDiffs = historicalRates.map((r) => Math.pow(r - mean, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / historicalRates.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) {
    return 0;
  }

  return (currentRate - mean) / stdDev;
}
