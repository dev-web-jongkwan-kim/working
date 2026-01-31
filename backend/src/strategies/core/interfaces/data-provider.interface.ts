import { Candle, Timeframe } from './candle.interface';

/**
 * Data Provider Interface
 * Abstracts data access for both live trading and backtesting
 *
 * Live trading: Uses DataCacheService (Redis) for real-time data
 * Backtesting: Uses BacktestDataAdapter with historical data
 */
export interface IDataProvider {
  /**
   * Get historical candles for a symbol and timeframe
   * @param symbol Trading pair (e.g., 'BTCUSDT')
   * @param timeframe Candle timeframe
   * @param count Number of candles to retrieve
   * @returns Array of candles, oldest first
   */
  getCandles(symbol: string, timeframe: Timeframe, count: number): Candle[];

  /**
   * Get current price for a symbol
   * @param symbol Trading pair
   * @returns Current price or null if unavailable
   */
  getCurrentPrice(symbol: string): number | null;

  /**
   * Get current funding rate for a symbol
   * @param symbol Trading pair
   * @returns Funding rate (e.g., 0.0001 = 0.01%) or null if unavailable
   */
  getFundingRate(symbol: string): number | null;

  /**
   * Get historical funding rates for a symbol
   * @param symbol Trading pair
   * @param count Number of historical funding rates (8-hour intervals)
   * @returns Array of funding rates, oldest first
   */
  getFundingHistory(symbol: string, count: number): number[];

  /**
   * Get current timestamp
   * Live: Returns actual current time
   * Backtest: Returns simulated current time
   */
  getCurrentTime(): number;

  /**
   * Get list of tradable symbols
   */
  getSymbols(): string[];
}
