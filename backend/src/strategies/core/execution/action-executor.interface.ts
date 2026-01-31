/**
 * Action Executor Interface
 *
 * Unified interface for executing trading actions in both live and backtest environments.
 * This abstraction ensures 100% logic consistency between live trading and backtesting.
 *
 * Key principle: The PositionStateMachine emits actions, and the executor handles them.
 * This separation allows identical state machine logic to drive both environments.
 */

export interface PositionContext {
  /** Symbol being traded */
  symbol: string;

  /** Trade direction */
  direction: 'LONG' | 'SHORT';

  /** Entry price */
  entryPrice: number;

  /** Entry timestamp (ms) */
  entryTime: number;

  /** Initial position size in USD */
  initialSizeUsd: number;

  /** Remaining position size in USD (after partial closes) */
  remainingSizeUsd: number;

  /** Current stop loss price */
  slPrice: number;

  /** TP1 price */
  tp1Price?: number;

  /** Current trailing stop price (if active) */
  trailingStopPrice?: number;

  /** Whether TP1 has been hit */
  tp1Hit: boolean;

  /** Realized PnL from partial closes (USD) */
  realizedPnl: number;

  /** Accumulated funding cost (USD) */
  fundingCost: number;

  /** Strategy type */
  strategyType: string;

  /** Trade/position ID for tracking */
  tradeId?: string;

  /** Leverage */
  leverage: number;

  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface CloseResult {
  /** PnL from this close action */
  pnl: number;

  /** Exit price */
  exitPrice: number;

  /** Quantity closed (USD) */
  closedSizeUsd: number;

  /** Whether close was successful */
  success: boolean;

  /** Error message if failed */
  error?: string;
}

export interface FundingCostResult {
  /** Total funding cost (positive = paid, negative = received) */
  totalCost: number;

  /** Number of funding periods */
  periods: number;

  /** Average funding rate */
  avgRate: number;
}

/**
 * IActionExecutor Interface
 *
 * Implementations:
 * - BacktestActionExecutor: Simulates executions with historical data
 * - LiveActionExecutor: Executes real orders via Binance API
 */
export interface IActionExecutor {
  /**
   * Close a partial position (e.g., at TP1)
   *
   * @param ctx Position context
   * @param percent Percentage of REMAINING position to close (0-100)
   * @param price Target close price
   * @param reason Reason for closing (e.g., 'TP1', 'PARTIAL_TAKE_PROFIT')
   * @returns Close result with PnL
   */
  closePartial(
    ctx: PositionContext,
    percent: number,
    price: number,
    reason: string,
  ): Promise<CloseResult>;

  /**
   * Move stop loss to breakeven (entry price)
   *
   * @param ctx Position context
   * @returns Updated position context
   */
  moveSLToBreakeven(ctx: PositionContext): Promise<PositionContext>;

  /**
   * Update trailing stop price
   *
   * @param ctx Position context
   * @param newPrice New trailing stop price
   * @returns Updated position context
   */
  updateTrailingStop(
    ctx: PositionContext,
    newPrice: number,
  ): Promise<PositionContext>;

  /**
   * Close entire position
   *
   * @param ctx Position context
   * @param price Exit price
   * @param reason Exit reason
   * @returns Close result with total PnL
   */
  closeAll(
    ctx: PositionContext,
    price: number,
    reason: string,
  ): Promise<CloseResult>;

  /**
   * Calculate funding cost for a position over a time period
   *
   * @param symbol Trading symbol
   * @param sizeUsd Position size in USD
   * @param entryTime Entry timestamp (ms)
   * @param exitTime Exit timestamp (ms)
   * @param direction Trade direction
   * @returns Funding cost result
   */
  calculateFundingCost(
    symbol: string,
    sizeUsd: number,
    entryTime: number,
    exitTime: number,
    direction: 'LONG' | 'SHORT',
  ): Promise<FundingCostResult>;

  /**
   * Update SL order on the exchange (live only)
   * For backtest, this is a no-op but maintains interface consistency
   *
   * @param ctx Position context
   * @param newSlPrice New stop loss price
   * @returns Success status
   */
  updateSLOnExchange(
    ctx: PositionContext,
    newSlPrice: number,
  ): Promise<{ success: boolean; error?: string }>;

  /**
   * Get current market price for a symbol
   *
   * @param symbol Trading symbol
   * @returns Current price or null if unavailable
   */
  getCurrentPrice(symbol: string): Promise<number | null>;
}

/**
 * Action types that can be executed
 * These match the TransitionAction types from state-transitions.ts
 */
export type ExecutableAction =
  | { type: 'CLOSE_PARTIAL'; percent: number; reason: string }
  | { type: 'CLOSE_ALL'; reason: string }
  | { type: 'MOVE_SL_TO_BREAKEVEN' }
  | { type: 'UPDATE_TRAILING_STOP'; price: number }
  | { type: 'UPDATE_SL_ON_EXCHANGE'; price: number }
  | { type: 'CALCULATE_FUNDING_COST' };
