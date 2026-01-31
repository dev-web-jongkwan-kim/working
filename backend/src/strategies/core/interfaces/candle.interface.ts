/**
 * Timeframe types supported by the strategy system
 */
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

/**
 * OHLCV Candle data structure
 * Used by both live trading and backtesting
 */
export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTime: number;    // Unix timestamp in ms
  closeTime: number;   // Unix timestamp in ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;     // Number of trades (optional)
}
