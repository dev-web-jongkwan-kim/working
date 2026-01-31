import { IDataProvider, Candle, Timeframe } from '../../strategies/core/interfaces';

/**
 * Backtest Data Adapter
 *
 * Implements IDataProvider for backtesting with historical data.
 * Provides the same interface as LiveDataAdapter but uses pre-loaded
 * historical data and simulates time progression.
 */
export class BacktestDataAdapter implements IDataProvider {
  private candleData: Map<string, Candle[]> = new Map();
  private fundingData: Map<string, number[]> = new Map();
  private currentTimeMs: number = 0;
  private symbols: string[] = [];

  // Index tracking for each symbol/timeframe combination
  private currentIndices: Map<string, number> = new Map();

  constructor() {}

  /**
   * Initialize with historical data
   * @param candleData Map of "symbol_timeframe" -> candles
   * @param fundingData Map of symbol -> funding rates
   * @param symbols List of tradable symbols
   */
  initialize(
    candleData: Map<string, Candle[]>,
    fundingData: Map<string, number[]>,
    symbols: string[],
  ): void {
    this.candleData = candleData;
    this.fundingData = fundingData;
    this.symbols = symbols;

    // Initialize indices to start
    for (const key of candleData.keys()) {
      this.currentIndices.set(key, 0);
    }
  }

  /**
   * Set current simulation time
   * Updates indices to point to candles up to this time
   */
  setCurrentTime(timeMs: number): void {
    this.currentTimeMs = timeMs;

    // Update all indices based on new time
    for (const [key, candles] of this.candleData.entries()) {
      let index = 0;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i].closeTime <= timeMs) {
          index = i + 1; // Point to next candle to include this one
        } else {
          break;
        }
      }
      this.currentIndices.set(key, index);
    }
  }

  /**
   * Get historical candles up to current simulation time
   */
  getCandles(symbol: string, timeframe: Timeframe, count: number): Candle[] {
    const key = `${symbol}_${timeframe}`;
    const candles = this.candleData.get(key);

    if (!candles) {
      return [];
    }

    const currentIndex = this.currentIndices.get(key) || 0;
    const availableCandles = candles.slice(0, currentIndex);

    return availableCandles.slice(-count);
  }

  /**
   * Get current price (close of most recent candle)
   */
  getCurrentPrice(symbol: string): number | null {
    // Try 15m first, then 1h, then 4h, then 1d
    const timeframes: Timeframe[] = ['15m', '1h', '4h', '1d'];

    for (const tf of timeframes) {
      const candles = this.getCandles(symbol, tf, 1);
      if (candles.length > 0) {
        return candles[0].close;
      }
    }

    return null;
  }

  /**
   * Get current funding rate
   * Interpolates based on simulation time (funding updates every 8h)
   */
  getFundingRate(symbol: string): number | null {
    const fundingRates = this.fundingData.get(symbol);

    if (!fundingRates || fundingRates.length === 0) {
      return null;
    }

    // Calculate which funding period we're in
    // Funding updates at 00:00, 08:00, 16:00 UTC
    const msPerFundingPeriod = 8 * 60 * 60 * 1000;
    const fundingIndex = Math.floor(this.currentTimeMs / msPerFundingPeriod) % fundingRates.length;

    return fundingRates[Math.min(fundingIndex, fundingRates.length - 1)];
  }

  /**
   * Get historical funding rates up to current time
   */
  getFundingHistory(symbol: string, count: number): number[] {
    const fundingRates = this.fundingData.get(symbol);

    if (!fundingRates) {
      return [];
    }

    // Calculate current funding index
    const msPerFundingPeriod = 8 * 60 * 60 * 1000;
    const currentFundingIndex = Math.floor(this.currentTimeMs / msPerFundingPeriod);
    const availableCount = Math.min(currentFundingIndex + 1, fundingRates.length);

    return fundingRates.slice(0, availableCount).slice(-count);
  }

  /**
   * Get current simulation time
   */
  getCurrentTime(): number {
    return this.currentTimeMs;
  }

  /**
   * Get list of tradable symbols
   */
  getSymbols(): string[] {
    return this.symbols;
  }

  /**
   * Calculate funding cost for a position over a time period
   * @param symbol Trading symbol
   * @param positionSize Position size in USD
   * @param startTime Position open time
   * @param endTime Position close time (or current time)
   * @param direction Trade direction
   * @returns Total funding cost (positive = paid, negative = received)
   */
  calculateFundingCost(
    symbol: string,
    positionSize: number,
    startTime: number,
    endTime: number,
    direction: 'LONG' | 'SHORT',
  ): number {
    const fundingRates = this.fundingData.get(symbol);

    if (!fundingRates || fundingRates.length === 0) {
      return 0;
    }

    const msPerFundingPeriod = 8 * 60 * 60 * 1000;
    const startPeriod = Math.floor(startTime / msPerFundingPeriod);
    const endPeriod = Math.floor(endTime / msPerFundingPeriod);

    let totalCost = 0;

    // Sum funding for each 8-hour period the position was held
    for (let period = startPeriod; period < endPeriod; period++) {
      const fundingIndex = period % fundingRates.length;
      const rate = fundingRates[fundingIndex];

      // For LONG: positive rate = pay, negative rate = receive
      // For SHORT: positive rate = receive, negative rate = pay
      const cost = direction === 'LONG' ? rate * positionSize : -rate * positionSize;
      totalCost += cost;
    }

    return totalCost;
  }

  /**
   * Get data availability summary
   */
  getDataSummary(): {
    symbols: string[];
    timeframes: string[];
    startTime: number;
    endTime: number;
    candleCount: number;
    fundingCount: number;
  } {
    const timeframes = new Set<string>();
    let startTime = Infinity;
    let endTime = 0;
    let candleCount = 0;
    let fundingCount = 0;

    for (const [key, candles] of this.candleData.entries()) {
      const [, tf] = key.split('_');
      timeframes.add(tf);

      if (candles.length > 0) {
        startTime = Math.min(startTime, candles[0].openTime);
        endTime = Math.max(endTime, candles[candles.length - 1].closeTime);
        candleCount += candles.length;
      }
    }

    for (const rates of this.fundingData.values()) {
      fundingCount += rates.length;
    }

    return {
      symbols: this.symbols,
      timeframes: Array.from(timeframes),
      startTime: startTime === Infinity ? 0 : startTime,
      endTime,
      candleCount,
      fundingCount,
    };
  }
}

/**
 * Factory function to create and initialize a BacktestDataAdapter
 */
export function createBacktestAdapter(
  candleData: Map<string, Candle[]>,
  fundingData: Map<string, number[]>,
  symbols: string[],
): BacktestDataAdapter {
  const adapter = new BacktestDataAdapter();
  adapter.initialize(candleData, fundingData, symbols);
  return adapter;
}
