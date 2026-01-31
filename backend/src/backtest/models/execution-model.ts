/**
 * Realistic Execution Model for Backtesting
 *
 * Models real-world execution costs including:
 * - Dynamic slippage based on volatility (ATR)
 * - Market impact based on order size vs average volume
 * - Bid-ask spread modeling
 * - Partial fill probability for limit orders
 * - Gap risk for overnight/weekend positions
 */

export interface ExecutionModelConfig {
  /** Base spread as a fraction (e.g., 0.0001 = 0.01%) */
  baseSpreadRate: number;

  /** Base slippage for market orders (e.g., 0.0001 = 0.01%) */
  baseSlippageRate: number;

  /** ATR multiplier for volatility-based slippage */
  volatilitySlippageMultiplier: number;

  /** Market impact coefficient (sqrt model) */
  marketImpactCoefficient: number;

  /** Minimum participation rate to trigger market impact */
  marketImpactThreshold: number;

  /** Commission rate per side (e.g., 0.0004 = 0.04%) */
  commissionRate: number;

  /** Whether to simulate partial fills for limit orders */
  enablePartialFills: boolean;

  /** Base fill probability for limit orders at touch */
  baseFillProbability: number;

  /** Gap probability for positions held over 8+ hours */
  gapProbability: number;

  /** Maximum gap size as ATR multiple */
  maxGapAtrMultiple: number;
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionModelConfig = {
  baseSpreadRate: 0.0001, // 0.01%
  baseSlippageRate: 0.0001, // 0.01%
  volatilitySlippageMultiplier: 0.1, // 10% of ATR%
  marketImpactCoefficient: 0.1, // sqrt(participation) * 0.1
  marketImpactThreshold: 0.001, // 0.1% of daily volume
  commissionRate: 0.0004, // 0.04% per side (Binance futures taker)
  enablePartialFills: true,
  baseFillProbability: 0.7, // 70% base fill rate for limit orders
  gapProbability: 0.05, // 5% chance of gap on 4H+ holds
  maxGapAtrMultiple: 2.0, // Max 2 ATR gap
};

export const CONSERVATIVE_EXECUTION_CONFIG: ExecutionModelConfig = {
  baseSpreadRate: 0.0002, // 0.02%
  baseSlippageRate: 0.0002, // 0.02%
  volatilitySlippageMultiplier: 0.15, // 15% of ATR%
  marketImpactCoefficient: 0.15,
  marketImpactThreshold: 0.0005,
  commissionRate: 0.0005, // 0.05%
  enablePartialFills: true,
  baseFillProbability: 0.5,
  gapProbability: 0.1,
  maxGapAtrMultiple: 3.0,
};

export const STRESS_EXECUTION_CONFIG: ExecutionModelConfig = {
  baseSpreadRate: 0.0005, // 0.05%
  baseSlippageRate: 0.0005, // 0.05%
  volatilitySlippageMultiplier: 0.25, // 25% of ATR%
  marketImpactCoefficient: 0.25,
  marketImpactThreshold: 0.0002,
  commissionRate: 0.0005,
  enablePartialFills: true,
  baseFillProbability: 0.3,
  gapProbability: 0.2,
  maxGapAtrMultiple: 5.0,
};

export interface ExecutionContext {
  symbol: string;
  orderSizeUsd: number;
  currentPrice: number;
  atr: number;
  avgDailyVolumeUsd: number;
  isMarketOrder: boolean;
  isBuy: boolean;
  limitPrice?: number;
  holdingDurationMs?: number;
}

export interface ExecutionResult {
  /** Final execution price after all costs */
  executionPrice: number;

  /** Spread cost in USD */
  spreadCost: number;

  /** Slippage cost in USD */
  slippageCost: number;

  /** Market impact cost in USD */
  marketImpactCost: number;

  /** Commission cost in USD */
  commissionCost: number;

  /** Total execution cost in USD */
  totalCost: number;

  /** Total cost as percentage of order size */
  totalCostPercent: number;

  /** Whether order was filled (for limit orders) */
  filled: boolean;

  /** Fill percentage (for partial fills) */
  fillPercent: number;

  /** Gap adjustment (if any) */
  gapAdjustment: number;

  /** Detailed breakdown */
  breakdown: {
    spreadRate: number;
    slippageRate: number;
    marketImpactRate: number;
    totalRate: number;
  };
}

/**
 * Realistic Execution Model
 *
 * Calculates execution costs based on market conditions
 */
export class ExecutionModel {
  private config: ExecutionModelConfig;
  private random: () => number;

  constructor(
    config: Partial<ExecutionModelConfig> = {},
    randomSeed?: number,
  ) {
    this.config = { ...DEFAULT_EXECUTION_CONFIG, ...config };

    // Seeded random for reproducibility
    if (randomSeed !== undefined) {
      this.random = this.seededRandom(randomSeed);
    } else {
      this.random = Math.random;
    }
  }

  /**
   * Calculate execution result for an order
   */
  execute(ctx: ExecutionContext): ExecutionResult {
    const atrPercent = ctx.atr / ctx.currentPrice;
    const participation = ctx.avgDailyVolumeUsd > 0
      ? ctx.orderSizeUsd / ctx.avgDailyVolumeUsd
      : 0;

    // 1. Calculate spread cost
    const spreadRate = this.calculateSpread(atrPercent);
    const spreadCost = ctx.orderSizeUsd * spreadRate;

    // 2. Calculate slippage (for market orders or limit orders that cross)
    let slippageRate = 0;
    if (ctx.isMarketOrder) {
      slippageRate = this.calculateSlippage(atrPercent);
    }
    const slippageCost = ctx.orderSizeUsd * slippageRate;

    // 3. Calculate market impact
    const marketImpactRate = this.calculateMarketImpact(participation);
    const marketImpactCost = ctx.orderSizeUsd * marketImpactRate;

    // 4. Calculate commission
    const commissionCost = ctx.orderSizeUsd * this.config.commissionRate;

    // 5. Calculate gap adjustment (for longer holds)
    let gapAdjustment = 0;
    if (ctx.holdingDurationMs && ctx.holdingDurationMs > 8 * 60 * 60 * 1000) {
      gapAdjustment = this.calculateGapRisk(ctx.atr, ctx.isBuy);
    }

    // 6. Calculate fill probability for limit orders
    let filled = true;
    let fillPercent = 100;
    if (!ctx.isMarketOrder && this.config.enablePartialFills && ctx.limitPrice) {
      const fillResult = this.calculateFillProbability(
        ctx.limitPrice,
        ctx.currentPrice,
        ctx.isBuy,
        atrPercent,
      );
      filled = fillResult.filled;
      fillPercent = fillResult.fillPercent;
    }

    // Calculate total
    const totalRate = spreadRate + slippageRate + marketImpactRate + this.config.commissionRate;
    const totalCost = spreadCost + slippageCost + marketImpactCost + commissionCost;

    // Calculate execution price
    const priceImpact = totalRate + (gapAdjustment / ctx.currentPrice);
    const executionPrice = ctx.isBuy
      ? ctx.currentPrice * (1 + priceImpact)
      : ctx.currentPrice * (1 - priceImpact);

    return {
      executionPrice,
      spreadCost,
      slippageCost,
      marketImpactCost,
      commissionCost,
      totalCost,
      totalCostPercent: totalRate * 100,
      filled,
      fillPercent,
      gapAdjustment,
      breakdown: {
        spreadRate,
        slippageRate,
        marketImpactRate,
        totalRate,
      },
    };
  }

  /**
   * Calculate spread based on volatility
   * Higher volatility = wider spread
   */
  private calculateSpread(atrPercent: number): number {
    // Base spread + volatility component
    const volatilitySpread = atrPercent * 0.05; // 5% of ATR as spread
    return this.config.baseSpreadRate + volatilitySpread;
  }

  /**
   * Calculate slippage for market orders
   * Based on volatility (ATR)
   */
  private calculateSlippage(atrPercent: number): number {
    // Base slippage + volatility-based slippage
    const volatilitySlippage = atrPercent * this.config.volatilitySlippageMultiplier;

    // Add random component (0.5x to 1.5x)
    const randomMultiplier = 0.5 + this.random();

    return (this.config.baseSlippageRate + volatilitySlippage) * randomMultiplier;
  }

  /**
   * Calculate market impact using square-root model
   * Impact = coefficient * sqrt(participation)
   */
  private calculateMarketImpact(participation: number): number {
    if (participation < this.config.marketImpactThreshold) {
      return 0;
    }

    // Square-root market impact model
    return this.config.marketImpactCoefficient * Math.sqrt(participation);
  }

  /**
   * Calculate gap risk for positions held over extended periods
   */
  private calculateGapRisk(atr: number, isBuy: boolean): number {
    if (this.random() > this.config.gapProbability) {
      return 0;
    }

    // Random gap size up to maxGapAtrMultiple ATRs
    const gapSize = this.random() * this.config.maxGapAtrMultiple * atr;

    // Gap direction is random but typically adverse
    // 70% chance of adverse gap
    const isAdverse = this.random() < 0.7;

    if (isBuy) {
      return isAdverse ? -gapSize : gapSize;
    } else {
      return isAdverse ? gapSize : -gapSize;
    }
  }

  /**
   * Calculate fill probability for limit orders
   */
  private calculateFillProbability(
    limitPrice: number,
    currentPrice: number,
    isBuy: boolean,
    atrPercent: number,
  ): { filled: boolean; fillPercent: number } {
    // Calculate distance from current price
    const distance = Math.abs(limitPrice - currentPrice) / currentPrice;

    // Base probability adjusted by distance
    // Closer to market = higher fill probability
    let fillProbability = this.config.baseFillProbability;

    if (isBuy && limitPrice < currentPrice) {
      // Buy limit below market - needs price to come down
      const distanceInAtr = distance / atrPercent;
      fillProbability *= Math.exp(-distanceInAtr * 0.5);
    } else if (!isBuy && limitPrice > currentPrice) {
      // Sell limit above market - needs price to go up
      const distanceInAtr = distance / atrPercent;
      fillProbability *= Math.exp(-distanceInAtr * 0.5);
    } else {
      // Crossing limit - should fill
      fillProbability = 0.95;
    }

    const filled = this.random() < fillProbability;

    // Partial fill simulation
    let fillPercent = 100;
    if (filled && this.config.enablePartialFills) {
      // 80% chance of full fill, 20% chance of partial
      if (this.random() < 0.2) {
        fillPercent = 50 + this.random() * 50; // 50-100%
      }
    }

    return { filled, fillPercent: filled ? fillPercent : 0 };
  }

  /**
   * Seeded random number generator for reproducibility
   */
  private seededRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
  }

  /**
   * Get current configuration
   */
  getConfig(): ExecutionModelConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<ExecutionModelConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * Factory functions for common configurations
 */
export function createDefaultExecutionModel(seed?: number): ExecutionModel {
  return new ExecutionModel(DEFAULT_EXECUTION_CONFIG, seed);
}

export function createConservativeExecutionModel(seed?: number): ExecutionModel {
  return new ExecutionModel(CONSERVATIVE_EXECUTION_CONFIG, seed);
}

export function createStressExecutionModel(seed?: number): ExecutionModel {
  return new ExecutionModel(STRESS_EXECUTION_CONFIG, seed);
}

/**
 * Calculate average daily volume from candle data
 */
export function calculateAvgDailyVolume(
  candles: Array<{ volume: number; close: number }>,
  lookbackDays: number = 20,
): number {
  if (candles.length === 0) return 0;

  // Assuming 1D candles or calculate from smaller timeframes
  const recentCandles = candles.slice(-lookbackDays);
  const totalVolumeUsd = recentCandles.reduce(
    (sum, c) => sum + c.volume * c.close,
    0,
  );

  return totalVolumeUsd / recentCandles.length;
}
