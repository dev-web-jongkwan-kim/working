/**
 * Volatility-based position sizing
 * Based on improve.md specifications:
 * - risk_per_trade = equity * 0.25%~0.75%
 * - qty = risk_per_trade / stop_distance
 */

/**
 * Position sizing configuration
 */
export interface SizingConfig {
  /** Percentage of equity to risk per trade (e.g., 0.005 = 0.5%) */
  riskPerTrade: number;

  /** Maximum position size in USD */
  maxPositionUsd: number;

  /** Minimum position size in USD */
  minPositionUsd: number;

  /** Maximum leverage */
  maxLeverage: number;

  /** Default leverage */
  defaultLeverage: number;
}

/**
 * Default sizing configuration
 */
export const DEFAULT_SIZING_CONFIG: SizingConfig = {
  riskPerTrade: 0.005,    // 0.5%
  maxPositionUsd: 10000,  // $10,000 max position
  minPositionUsd: 10,     // $10 min position
  maxLeverage: 20,
  defaultLeverage: 10,
};

/**
 * Position size calculation result
 */
export interface PositionSizeResult {
  /** Calculated position size in USD */
  positionSizeUsd: number;

  /** Margin required in USD */
  marginUsd: number;

  /** Leverage to use */
  leverage: number;

  /** Risk amount in USD */
  riskUsd: number;

  /** Position size in base currency */
  quantity: number;

  /** Whether size is valid (meets min/max constraints) */
  isValid: boolean;

  /** Reason if invalid */
  invalidReason?: string;
}

/**
 * Calculate position size based on volatility (ATR-based stop)
 *
 * Formula:
 * risk_usd = equity * risk_per_trade
 * stop_distance = atr * sl_atr_mult
 * position_size = risk_usd / (stop_distance / entry_price)
 *
 * @param equity Account equity in USD
 * @param entryPrice Entry price
 * @param atr ATR value
 * @param slAtrMult Stop loss ATR multiplier (e.g., 2.0)
 * @param config Sizing configuration
 * @returns Position size calculation result
 */
export function calculatePositionSize(
  equity: number,
  entryPrice: number,
  atr: number,
  slAtrMult: number,
  config: SizingConfig = DEFAULT_SIZING_CONFIG,
): PositionSizeResult {
  // Calculate risk amount
  const riskUsd = equity * config.riskPerTrade;

  // Calculate stop distance as percentage
  const stopDistancePrice = atr * slAtrMult;
  const stopDistancePercent = stopDistancePrice / entryPrice;

  // Avoid division by zero
  if (stopDistancePercent === 0) {
    return {
      positionSizeUsd: 0,
      marginUsd: 0,
      leverage: config.defaultLeverage,
      riskUsd,
      quantity: 0,
      isValid: false,
      invalidReason: 'Stop distance is zero',
    };
  }

  // Calculate position size
  // If we risk $50 with a 2% stop, position size = $50 / 0.02 = $2500
  let positionSizeUsd = riskUsd / stopDistancePercent;

  // Apply constraints
  positionSizeUsd = Math.min(positionSizeUsd, config.maxPositionUsd);
  positionSizeUsd = Math.max(positionSizeUsd, config.minPositionUsd);

  // Calculate leverage (position / margin)
  // With risk-based sizing, we need to determine margin
  // Margin = position / leverage
  // We want to ensure margin doesn't exceed a reasonable portion of equity
  const maxMarginPercent = 0.1; // 10% of equity per position
  const maxMarginUsd = equity * maxMarginPercent;

  let leverage = config.defaultLeverage;
  let marginUsd = positionSizeUsd / leverage;

  // If margin exceeds max, reduce position or increase leverage
  if (marginUsd > maxMarginUsd) {
    // Try increasing leverage first
    const requiredLeverage = positionSizeUsd / maxMarginUsd;
    if (requiredLeverage <= config.maxLeverage) {
      leverage = Math.ceil(requiredLeverage);
      marginUsd = positionSizeUsd / leverage;
    } else {
      // Cap at max leverage and reduce position
      leverage = config.maxLeverage;
      marginUsd = maxMarginUsd;
      positionSizeUsd = marginUsd * leverage;
    }
  }

  // Calculate quantity
  const quantity = positionSizeUsd / entryPrice;

  // Validate
  let isValid = true;
  let invalidReason: string | undefined;

  if (positionSizeUsd < config.minPositionUsd) {
    isValid = false;
    invalidReason = `Position size ${positionSizeUsd.toFixed(2)} below minimum ${config.minPositionUsd}`;
  }

  if (marginUsd > equity * 0.2) {
    isValid = false;
    invalidReason = `Margin ${marginUsd.toFixed(2)} exceeds 20% of equity`;
  }

  return {
    positionSizeUsd,
    marginUsd,
    leverage,
    riskUsd,
    quantity,
    isValid,
    invalidReason,
  };
}

/**
 * Calculate position size with fixed margin
 * Useful when margin is predetermined
 *
 * @param marginUsd Fixed margin amount in USD
 * @param entryPrice Entry price
 * @param leverage Leverage to use
 * @returns Position details
 */
export function calculatePositionFromMargin(
  marginUsd: number,
  entryPrice: number,
  leverage: number,
): { positionSizeUsd: number; quantity: number } {
  const positionSizeUsd = marginUsd * leverage;
  const quantity = positionSizeUsd / entryPrice;

  return { positionSizeUsd, quantity };
}

/**
 * Calculate risk metrics for a position
 *
 * @param entryPrice Entry price
 * @param slPrice Stop loss price
 * @param positionSizeUsd Position size in USD
 * @param direction Trade direction
 * @returns Risk metrics
 */
export function calculateRiskMetrics(
  entryPrice: number,
  slPrice: number,
  positionSizeUsd: number,
  direction: 'LONG' | 'SHORT',
): {
  riskUsd: number;
  riskPercent: number;
  stopDistancePercent: number;
} {
  const stopDistancePercent =
    direction === 'LONG'
      ? (entryPrice - slPrice) / entryPrice
      : (slPrice - entryPrice) / entryPrice;

  const riskUsd = positionSizeUsd * Math.abs(stopDistancePercent);
  const riskPercent = Math.abs(stopDistancePercent) * 100;

  return {
    riskUsd,
    riskPercent,
    stopDistancePercent: Math.abs(stopDistancePercent),
  };
}

/**
 * P2-2: Simplified correlation adjustment with hard cap
 *
 * Instead of complex correlation/sector analysis, we use a simple directional cap:
 * - Max 3 LONG positions at once
 * - Max 3 SHORT positions at once
 *
 * @param basePositionSize Original position size
 * @param sameDirectionCount Number of open positions in same direction
 * @param maxSameDirection Maximum positions in same direction (default: 3)
 * @returns Adjusted position size (0 if cap reached)
 */
export function adjustForCorrelation(
  basePositionSize: number,
  sameDirectionCount: number,
  maxSameDirection: number = 3, // P2-2: Default hard cap at 3
): number {
  // Hard cap: reject new position if at max
  if (sameDirectionCount >= maxSameDirection) {
    return 0; // Block new position
  }

  // Reduce position size as we approach max
  // At 0 positions: 100%, at 1: 83%, at 2: 67%
  const utilizationRatio = sameDirectionCount / maxSameDirection;
  const scaleFactor = 1 - utilizationRatio * 0.5; // Reduce by up to 50%

  return basePositionSize * Math.max(scaleFactor, 0.5);
}
