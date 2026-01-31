/**
 * Execution Layer
 *
 * Provides unified action executors for both live trading and backtesting.
 * This layer ensures 100% logic consistency between the two environments.
 */

export * from './action-executor.interface';
export * from './backtest-action-executor';
export * from './live-action-executor';
