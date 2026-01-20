export interface Candle {
  symbol: string;
  timeframe: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
