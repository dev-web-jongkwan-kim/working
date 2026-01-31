import { Injectable } from '@nestjs/common';
import { IDataProvider, Candle, Timeframe } from '../../strategies/core/interfaces';
import { DataCacheService } from '../../dual-strategy/services/data/data-cache.service';
import { SymbolFetcherService } from '../../dual-strategy/services/data/symbol-fetcher.service';

/**
 * Live Data Adapter
 *
 * Implements IDataProvider using DataCacheService for real-time trading.
 * Provides a consistent interface that strategies can use for both
 * live trading and backtesting.
 */
@Injectable()
export class LiveDataAdapter implements IDataProvider {
  private fundingHistory: Map<string, number[]> = new Map();
  private readonly MAX_FUNDING_HISTORY = 200;

  constructor(
    private readonly cacheService: DataCacheService,
    private readonly symbolFetcher: SymbolFetcherService,
  ) {}

  /**
   * Get historical candles from Redis cache
   */
  getCandles(symbol: string, timeframe: Timeframe, count: number): Candle[] {
    // Note: DataCacheService.getRecentCandles is async, but IDataProvider is sync
    // We need to handle this by pre-fetching or using a sync cache
    // For now, we'll throw if data isn't available synchronously
    // In practice, the orchestrator will ensure data is cached before calling strategies

    // This is a workaround - in the actual implementation, the orchestrator
    // pre-fetches all required data before calling strategy.generateSignal()
    throw new Error(
      'LiveDataAdapter.getCandles requires async pre-fetch. Use LiveDataAdapterAsync instead.',
    );
  }

  /**
   * Get current price from Redis cache
   */
  getCurrentPrice(symbol: string): number | null {
    throw new Error(
      'LiveDataAdapter.getCurrentPrice requires async. Use LiveDataAdapterAsync instead.',
    );
  }

  /**
   * Get current funding rate from Redis cache
   */
  getFundingRate(symbol: string): number | null {
    throw new Error(
      'LiveDataAdapter.getFundingRate requires async. Use LiveDataAdapterAsync instead.',
    );
  }

  /**
   * Get historical funding rates
   */
  getFundingHistory(symbol: string, count: number): number[] {
    const history = this.fundingHistory.get(symbol) || [];
    return history.slice(-count);
  }

  /**
   * Get current time (actual time for live trading)
   */
  getCurrentTime(): number {
    return Date.now();
  }

  /**
   * Get list of tradable symbols
   */
  getSymbols(): string[] {
    // Use cached symbols from SymbolFetcherService
    // This is sync because symbols are fetched at startup
    return [];
  }

  /**
   * Add funding rate to history (called by data collector)
   */
  addFundingRate(symbol: string, rate: number): void {
    if (!this.fundingHistory.has(symbol)) {
      this.fundingHistory.set(symbol, []);
    }

    const history = this.fundingHistory.get(symbol)!;
    history.push(rate);

    // Trim to max size
    if (history.length > this.MAX_FUNDING_HISTORY) {
      this.fundingHistory.set(symbol, history.slice(-this.MAX_FUNDING_HISTORY));
    }
  }

  /**
   * Initialize funding history from API
   */
  async initializeFundingHistory(symbol: string, rates: number[]): Promise<void> {
    this.fundingHistory.set(symbol, rates.slice(-this.MAX_FUNDING_HISTORY));
  }
}

/**
 * Async Live Data Adapter
 *
 * Async version that properly handles Redis cache operations.
 * Use this in the orchestrator, then convert to sync snapshot for strategies.
 */
@Injectable()
export class LiveDataAdapterAsync {
  private fundingHistory: Map<string, number[]> = new Map();
  private symbolsCache: string[] = [];
  private readonly MAX_FUNDING_HISTORY = 200;

  constructor(
    private readonly cacheService: DataCacheService,
    private readonly symbolFetcher: SymbolFetcherService,
  ) {}

  /**
   * Get historical candles from Redis cache (async)
   */
  async getCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const candles = await this.cacheService.getRecentCandles(symbol, timeframe as any, count);
    if (!candles) return [];
    // Map to correct Candle type (ensure timeframe type compatibility)
    return candles.map((c: any) => ({
      symbol: c.symbol,
      timeframe: c.timeframe as Timeframe,
      openTime: c.openTime,
      closeTime: c.closeTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      trades: c.trades,
    }));
  }

  /**
   * Get current price from Redis cache (async)
   */
  async getCurrentPrice(symbol: string): Promise<number | null> {
    return await this.cacheService.getCurrentPrice(symbol);
  }

  /**
   * Get current funding rate from Redis cache (async)
   */
  async getFundingRate(symbol: string): Promise<number | null> {
    return await this.cacheService.getFundingRate(symbol);
  }

  /**
   * Get historical funding rates
   */
  getFundingHistory(symbol: string, count: number): number[] {
    const history = this.fundingHistory.get(symbol) || [];
    return history.slice(-count);
  }

  /**
   * Get current time
   */
  getCurrentTime(): number {
    return Date.now();
  }

  /**
   * Get list of tradable symbols
   */
  async getSymbols(): Promise<string[]> {
    if (this.symbolsCache.length === 0) {
      this.symbolsCache = await this.symbolFetcher.getTopSymbols(100);
    }
    return this.symbolsCache;
  }

  /**
   * Refresh symbols cache
   */
  async refreshSymbols(): Promise<void> {
    this.symbolsCache = await this.symbolFetcher.getTopSymbols(100);
  }

  /**
   * Add funding rate to history
   */
  addFundingRate(symbol: string, rate: number): void {
    if (!this.fundingHistory.has(symbol)) {
      this.fundingHistory.set(symbol, []);
    }

    const history = this.fundingHistory.get(symbol)!;
    history.push(rate);

    if (history.length > this.MAX_FUNDING_HISTORY) {
      this.fundingHistory.set(symbol, history.slice(-this.MAX_FUNDING_HISTORY));
    }
  }

  /**
   * Initialize funding history
   */
  async initializeFundingHistory(symbol: string, rates: number[]): Promise<void> {
    this.fundingHistory.set(symbol, rates.slice(-this.MAX_FUNDING_HISTORY));
  }

  /**
   * Calculate funding cost for a position over a time period
   * Uses stored funding history for estimation
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
  ): { totalCost: number; periods: number; avgRate: number } {
    const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

    // Get funding history
    const fundingHistory = this.fundingHistory.get(symbol) || [];
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
   * Create a sync data snapshot for strategy execution
   * Pre-fetches all required data and returns a sync provider
   */
  async createSnapshot(
    symbols: string[],
    timeframes: Timeframe[],
  ): Promise<DataSnapshot> {
    const snapshot = new DataSnapshot();

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const candles = await this.getCandles(symbol, timeframe, 250);
        snapshot.setCandles(symbol, timeframe, candles);
      }

      const price = await this.getCurrentPrice(symbol);
      if (price !== null) {
        snapshot.setCurrentPrice(symbol, price);
      }

      const funding = await this.getFundingRate(symbol);
      if (funding !== null) {
        snapshot.setFundingRate(symbol, funding);
      }

      const fundingHistory = this.getFundingHistory(symbol, this.MAX_FUNDING_HISTORY);
      snapshot.setFundingHistory(symbol, fundingHistory);
    }

    snapshot.setSymbols(symbols);
    snapshot.setCurrentTime(this.getCurrentTime());

    return snapshot;
  }
}

/**
 * Data Snapshot
 *
 * Synchronous data provider created from async fetch.
 * Used to provide data to strategies which expect sync interface.
 */
export class DataSnapshot implements IDataProvider {
  private candleCache: Map<string, Candle[]> = new Map();
  private priceCache: Map<string, number> = new Map();
  private fundingCache: Map<string, number> = new Map();
  private fundingHistoryCache: Map<string, number[]> = new Map();
  private symbols: string[] = [];
  private currentTime: number = Date.now();

  setCandles(symbol: string, timeframe: Timeframe, candles: Candle[]): void {
    const key = `${symbol}:${timeframe}`;
    this.candleCache.set(key, candles);
  }

  setCurrentPrice(symbol: string, price: number): void {
    this.priceCache.set(symbol, price);
  }

  setFundingRate(symbol: string, rate: number): void {
    this.fundingCache.set(symbol, rate);
  }

  setFundingHistory(symbol: string, rates: number[]): void {
    this.fundingHistoryCache.set(symbol, rates);
  }

  setSymbols(symbols: string[]): void {
    this.symbols = symbols;
  }

  setCurrentTime(time: number): void {
    this.currentTime = time;
  }

  // IDataProvider implementation
  getCandles(symbol: string, timeframe: Timeframe, count: number): Candle[] {
    const key = `${symbol}:${timeframe}`;
    const candles = this.candleCache.get(key) || [];
    return candles.slice(-count);
  }

  getCurrentPrice(symbol: string): number | null {
    return this.priceCache.get(symbol) ?? null;
  }

  getFundingRate(symbol: string): number | null {
    return this.fundingCache.get(symbol) ?? null;
  }

  getFundingHistory(symbol: string, count: number): number[] {
    const history = this.fundingHistoryCache.get(symbol) || [];
    return history.slice(-count);
  }

  getCurrentTime(): number {
    return this.currentTime;
  }

  getSymbols(): string[] {
    return this.symbols;
  }

  /**
   * Calculate funding cost for a position (using stored history)
   */
  calculateFundingCost(
    symbol: string,
    sizeUsd: number,
    entryTime: number,
    exitTime: number,
    direction: 'LONG' | 'SHORT',
  ): number {
    const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
    const fundingHistory = this.fundingHistoryCache.get(symbol) || [];

    if (fundingHistory.length === 0) return 0;

    const holdingDuration = exitTime - entryTime;
    const periods = Math.floor(holdingDuration / FUNDING_INTERVAL_MS);

    if (periods === 0) return 0;

    const relevantRates = fundingHistory.slice(-periods);
    let totalCost = 0;

    for (const rate of relevantRates) {
      totalCost += direction === 'LONG' ? sizeUsd * rate : sizeUsd * -rate;
    }

    return totalCost;
  }
}
