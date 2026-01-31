import { IDataProvider } from './data-provider.interface';
import { TradingSignal } from './signal.interface';

/**
 * Strategy Interface
 * All strategies must implement this interface for consistent behavior
 * between live trading and backtesting
 */
export interface IStrategy {
  /**
   * Strategy identifier
   */
  readonly name: string;

  /**
   * Generate trading signals for a symbol
   * @param symbol Trading pair (e.g., 'BTCUSDT')
   * @param dataProvider Data access interface
   * @returns TradingSignal or null if no signal
   */
  generateSignal(symbol: string, dataProvider: IDataProvider): TradingSignal | null;

  /**
   * Get the primary timeframe for this strategy
   * Used for event-driven signal generation
   */
  getSignalTimeframe(): string;

  /**
   * Get the entry timeframe for this strategy
   * May differ from signal timeframe for multi-timeframe strategies
   */
  getEntryTimeframe(): string;
}

/**
 * Strategy configuration base interface
 */
export interface IStrategyConfig {
  /** Whether the strategy is enabled */
  enabled: boolean;

  /** Maximum concurrent positions for this strategy */
  maxPositions: number;

  /** Cooldown in bars after closing a position */
  cooldownBars: number;

  /** Risk parameters */
  risk: {
    /** Percentage of equity to risk per trade (e.g., 0.005 = 0.5%) */
    riskPerTrade: number;

    /** Maximum daily loss as percentage of equity */
    dailyLossLimit: number;
  };
}
