/**
 * Backtest Action Executor
 *
 * Implements IActionExecutor for backtesting.
 * Simulates trade execution using historical data without touching real exchanges.
 *
 * Key features:
 * - Realistic execution model with dynamic slippage
 * - Market impact simulation for larger orders
 * - Funding costs from historical funding rates
 * - Maintains position state consistently with live executor
 */

import {
  IActionExecutor,
  PositionContext,
  CloseResult,
  FundingCostResult,
} from './action-executor.interface';
import {
  ExecutionModel,
  ExecutionModelConfig,
  ExecutionContext,
  DEFAULT_EXECUTION_CONFIG,
  calculateAvgDailyVolume,
} from '../../../backtest/models/execution-model';

export interface BacktestExecutorConfig {
  /** Commission rate (e.g., 0.0005 = 0.05%) - legacy, now part of execution model */
  commissionRate: number;

  /** Slippage rate (e.g., 0.0001 = 0.01%) - legacy, now part of execution model */
  slippageRate: number;

  /** Use realistic execution model */
  useRealisticExecution: boolean;

  /** Execution model configuration */
  executionModelConfig?: Partial<ExecutionModelConfig>;

  /** Random seed for reproducibility */
  randomSeed?: number;
}

export interface BacktestDataSource {
  /** Get current price at simulation time */
  getCurrentPrice(symbol: string): number | null;

  /** Get funding rate history for cost calculation */
  getFundingHistory(symbol: string, count: number): number[];

  /** Get current simulation time */
  getCurrentTime(): number;

  /** Get ATR for a symbol (optional, for realistic execution) */
  getATR?(symbol: string): number | null;

  /** Get average daily volume USD (optional, for market impact) */
  getAvgDailyVolumeUsd?(symbol: string): number | null;
}

const DEFAULT_CONFIG: BacktestExecutorConfig = {
  commissionRate: 0.0005, // 0.05% (maker/taker average)
  slippageRate: 0.0001, // 0.01%
  useRealisticExecution: true,
  randomSeed: undefined,
};

export class BacktestActionExecutor implements IActionExecutor {
  private config: BacktestExecutorConfig;
  private dataSource: BacktestDataSource;
  private executionModel: ExecutionModel | null = null;

  // Execution statistics
  private executionStats = {
    totalOrders: 0,
    totalSlippageCost: 0,
    totalSpreadCost: 0,
    totalMarketImpactCost: 0,
    totalCommissionCost: 0,
    avgSlippagePercent: 0,
  };

  constructor(
    dataSource: BacktestDataSource,
    config: Partial<BacktestExecutorConfig> = {},
  ) {
    this.dataSource = dataSource;
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.useRealisticExecution) {
      this.executionModel = new ExecutionModel(
        this.config.executionModelConfig || DEFAULT_EXECUTION_CONFIG,
        this.config.randomSeed,
      );
    }
  }

  /**
   * Close a partial position (e.g., at TP1)
   */
  async closePartial(
    ctx: PositionContext,
    percent: number,
    price: number,
    reason: string,
  ): Promise<CloseResult> {
    // Validate percent
    if (percent <= 0 || percent > 100) {
      return {
        pnl: 0,
        exitPrice: price,
        closedSizeUsd: 0,
        success: false,
        error: `Invalid percent: ${percent}. Must be between 0 and 100.`,
      };
    }

    // Calculate close size
    const closedSizeUsd = ctx.remainingSizeUsd * (percent / 100);
    const isLong = ctx.direction === 'LONG';

    let exitPrice: number;
    let totalCost: number;

    if (this.config.useRealisticExecution && this.executionModel) {
      // Use realistic execution model
      const execCtx = this.createExecutionContext(ctx, closedSizeUsd, price, !isLong);
      const result = this.executionModel.execute(execCtx);

      exitPrice = result.executionPrice;
      totalCost = result.totalCost;

      // Update statistics
      this.updateExecutionStats(result);
    } else {
      // Legacy simple slippage
      const slippageMultiplier = isLong
        ? 1 - this.config.slippageRate
        : 1 + this.config.slippageRate;
      exitPrice = price * slippageMultiplier;
      totalCost = closedSizeUsd * this.config.commissionRate;
    }

    // Calculate PnL
    const pnl = this.calculatePnlForSize(
      ctx.entryPrice,
      exitPrice,
      closedSizeUsd,
      isLong,
    ) - totalCost;

    return {
      pnl,
      exitPrice,
      closedSizeUsd,
      success: true,
    };
  }

  /**
   * Move stop loss to breakeven
   */
  async moveSLToBreakeven(ctx: PositionContext): Promise<PositionContext> {
    return {
      ...ctx,
      slPrice: ctx.entryPrice,
    };
  }

  /**
   * Update trailing stop price
   */
  async updateTrailingStop(
    ctx: PositionContext,
    newPrice: number,
  ): Promise<PositionContext> {
    const isLong = ctx.direction === 'LONG';

    // Only update if better (higher for long, lower for short)
    if (ctx.trailingStopPrice === undefined) {
      return { ...ctx, trailingStopPrice: newPrice };
    }

    if (isLong && newPrice > ctx.trailingStopPrice) {
      return { ...ctx, trailingStopPrice: newPrice };
    }

    if (!isLong && newPrice < ctx.trailingStopPrice) {
      return { ...ctx, trailingStopPrice: newPrice };
    }

    return ctx;
  }

  /**
   * Close entire position
   */
  async closeAll(
    ctx: PositionContext,
    price: number,
    reason: string,
  ): Promise<CloseResult> {
    const isLong = ctx.direction === 'LONG';

    let exitPrice: number;
    let totalCost: number;

    if (this.config.useRealisticExecution && this.executionModel) {
      // Use realistic execution model
      const execCtx = this.createExecutionContext(ctx, ctx.remainingSizeUsd, price, !isLong);

      // For stop loss hits, add extra slippage (adverse conditions)
      if (reason === 'STOP_LOSS' || reason === 'TRAILING_STOP') {
        execCtx.atr = execCtx.atr * 1.5; // Higher volatility during SL execution
      }

      const result = this.executionModel.execute(execCtx);

      exitPrice = result.executionPrice;
      totalCost = result.totalCost;

      // Add gap risk for SL (simulates adverse gap)
      if (reason === 'STOP_LOSS' && result.gapAdjustment !== 0) {
        exitPrice = isLong
          ? exitPrice - Math.abs(result.gapAdjustment)
          : exitPrice + Math.abs(result.gapAdjustment);
      }

      this.updateExecutionStats(result);
    } else {
      // Legacy simple slippage
      const slippageMultiplier = isLong
        ? 1 - this.config.slippageRate
        : 1 + this.config.slippageRate;
      exitPrice = price * slippageMultiplier;
      totalCost = ctx.remainingSizeUsd * this.config.commissionRate;
    }

    // Calculate PnL for remaining size
    const pnl = this.calculatePnlForSize(
      ctx.entryPrice,
      exitPrice,
      ctx.remainingSizeUsd,
      isLong,
    ) - totalCost;

    return {
      pnl,
      exitPrice,
      closedSizeUsd: ctx.remainingSizeUsd,
      success: true,
    };
  }

  /**
   * Calculate funding cost for a position
   *
   * Funding is settled every 8 hours on Binance.
   * For LONG: positive rate = pay, negative rate = receive
   * For SHORT: positive rate = receive, negative rate = pay
   */
  async calculateFundingCost(
    symbol: string,
    sizeUsd: number,
    entryTime: number,
    exitTime: number,
    direction: 'LONG' | 'SHORT',
  ): Promise<FundingCostResult> {
    const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

    // Get funding history
    const fundingHistory = this.dataSource.getFundingHistory(symbol, 200);
    if (fundingHistory.length === 0) {
      return { totalCost: 0, periods: 0, avgRate: 0 };
    }

    // Calculate number of funding periods
    const holdingDuration = exitTime - entryTime;
    const periods = Math.floor(holdingDuration / FUNDING_INTERVAL_MS);

    if (periods === 0) {
      return { totalCost: 0, periods: 0, avgRate: 0 };
    }

    // Use most recent funding rates for estimation
    const relevantRates = fundingHistory.slice(-periods);
    const avgRate =
      relevantRates.reduce((a, b) => a + b, 0) / relevantRates.length;

    // Calculate total funding cost
    // LONG: Pay when rate > 0, receive when rate < 0
    // SHORT: Receive when rate > 0, pay when rate < 0
    let totalCost = 0;
    for (const rate of relevantRates) {
      const periodCost =
        direction === 'LONG' ? sizeUsd * rate : sizeUsd * -rate;
      totalCost += periodCost;
    }

    return {
      totalCost,
      periods,
      avgRate,
    };
  }

  /**
   * Update SL on exchange - no-op for backtest
   */
  async updateSLOnExchange(
    ctx: PositionContext,
    newSlPrice: number,
  ): Promise<{ success: boolean; error?: string }> {
    // In backtest, SL is tracked locally, no exchange update needed
    return { success: true };
  }

  /**
   * Get current price from data source
   */
  async getCurrentPrice(symbol: string): Promise<number | null> {
    return this.dataSource.getCurrentPrice(symbol);
  }

  /**
   * Calculate PnL for a given position size
   */
  private calculatePnlForSize(
    entryPrice: number,
    exitPrice: number,
    positionSizeUsd: number,
    isLong: boolean,
  ): number {
    const priceDiff = isLong
      ? exitPrice - entryPrice
      : entryPrice - exitPrice;
    return (priceDiff / entryPrice) * positionSizeUsd;
  }

  /**
   * Create execution context from position context
   */
  private createExecutionContext(
    ctx: PositionContext,
    orderSizeUsd: number,
    currentPrice: number,
    isBuy: boolean,
  ): ExecutionContext {
    // Get ATR if available
    let atr = currentPrice * 0.02; // Default 2% if not available
    if (this.dataSource.getATR) {
      const atrValue = this.dataSource.getATR(ctx.symbol);
      if (atrValue !== null) {
        atr = atrValue;
      }
    }

    // Get average daily volume if available
    let avgDailyVolumeUsd = orderSizeUsd * 1000; // Default: assume 0.1% participation
    if (this.dataSource.getAvgDailyVolumeUsd) {
      const volumeValue = this.dataSource.getAvgDailyVolumeUsd(ctx.symbol);
      if (volumeValue !== null) {
        avgDailyVolumeUsd = volumeValue;
      }
    }

    // Calculate holding duration
    const currentTime = this.dataSource.getCurrentTime();
    const holdingDurationMs = currentTime - ctx.entryTime;

    return {
      symbol: ctx.symbol,
      orderSizeUsd,
      currentPrice,
      atr,
      avgDailyVolumeUsd,
      isMarketOrder: true, // Backtest assumes market orders for simplicity
      isBuy,
      holdingDurationMs,
    };
  }

  /**
   * Update execution statistics
   */
  private updateExecutionStats(result: {
    slippageCost: number;
    spreadCost: number;
    marketImpactCost: number;
    commissionCost: number;
    breakdown: { totalRate: number };
  }): void {
    this.executionStats.totalOrders++;
    this.executionStats.totalSlippageCost += result.slippageCost;
    this.executionStats.totalSpreadCost += result.spreadCost;
    this.executionStats.totalMarketImpactCost += result.marketImpactCost;
    this.executionStats.totalCommissionCost += result.commissionCost;

    // Running average
    this.executionStats.avgSlippagePercent =
      (this.executionStats.avgSlippagePercent * (this.executionStats.totalOrders - 1) +
        result.breakdown.totalRate * 100) /
      this.executionStats.totalOrders;
  }

  /**
   * Get execution statistics
   */
  getExecutionStats(): typeof this.executionStats & {
    totalExecutionCost: number;
  } {
    return {
      ...this.executionStats,
      totalExecutionCost:
        this.executionStats.totalSlippageCost +
        this.executionStats.totalSpreadCost +
        this.executionStats.totalMarketImpactCost +
        this.executionStats.totalCommissionCost,
    };
  }

  /**
   * Reset execution statistics
   */
  resetExecutionStats(): void {
    this.executionStats = {
      totalOrders: 0,
      totalSlippageCost: 0,
      totalSpreadCost: 0,
      totalMarketImpactCost: 0,
      totalCommissionCost: 0,
      avgSlippagePercent: 0,
    };
  }

  /**
   * Set data source (useful for updating simulation time)
   */
  setDataSource(dataSource: BacktestDataSource): void {
    this.dataSource = dataSource;
  }

  /**
   * Get current configuration
   */
  getConfig(): BacktestExecutorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  setConfig(config: Partial<BacktestExecutorConfig>): void {
    this.config = { ...this.config, ...config };

    if (this.config.useRealisticExecution) {
      this.executionModel = new ExecutionModel(
        this.config.executionModelConfig || DEFAULT_EXECUTION_CONFIG,
        this.config.randomSeed,
      );
    }
  }
}
