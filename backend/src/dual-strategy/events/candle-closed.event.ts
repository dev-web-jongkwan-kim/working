import { Timeframe } from '../interfaces/candle.interface';

/**
 * Event emitted when a candle closes
 * CRITICAL: This enables immediate reaction (< 0.1s) instead of waiting for cron (up to 59s)
 */
export class CandleClosedEvent {
  constructor(
    public readonly symbol: string,
    public readonly timeframe: Timeframe,
    public readonly closeTime: number,
    public readonly closePrice: number,
    public readonly volume: number,
  ) {}
}
