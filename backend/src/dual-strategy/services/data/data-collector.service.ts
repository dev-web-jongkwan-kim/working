import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as WebSocket from 'ws';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { SystemEventType } from '../../../entities/system-log.entity';
import { DataCacheService } from './data-cache.service';
import { Candle, Timeframe } from '../../interfaces/candle.interface';
import { CandleClosedEvent } from '../../events/candle-closed.event';

interface BinanceKline {
  e: string;      // Event type
  E: number;      // Event time
  s: string;      // Symbol
  k: {
    t: number;    // Kline start time
    T: number;    // Kline close time
    s: string;    // Symbol
    i: string;    // Interval
    f: number;    // First trade ID
    L: number;    // Last trade ID
    o: string;    // Open price
    c: string;    // Close price
    h: string;    // High price
    l: string;    // Low price
    v: string;    // Base asset volume
    n: number;    // Number of trades
    x: boolean;   // Is this kline closed?
    q: string;    // Quote asset volume
    V: string;    // Taker buy base asset volume
    Q: string;    // Taker buy quote asset volume
  };
}

/**
 * Data Collector Service
 * Collects real-time candle data from Binance WebSocket
 * Stores in Redis cache for fast access
 */
@Injectable()
export class DataCollectorService implements OnModuleInit {
  private wsConnections: Map<string, WebSocket> = new Map();
  private symbols: string[] = [];
  private timeframes: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
  private isTestnet: boolean;
  private zeroVolumeCount: Map<string, number> = new Map(); // Track consecutive zero-volume candles
  private readonly MAX_ZERO_VOLUME_CANDLES = 3; // Remove symbol after 3 consecutive zero-volume candles

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: CustomLoggerService,
    private readonly cacheService: DataCacheService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.isTestnet = this.configService.get('BINANCE_TESTNET', 'true') === 'true';
  }

  async onModuleInit() {
    // Wait a bit for Redis to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    this.logger.log('DataCollectorService initialized', 'DataCollectorService');
    await this.logger.logSystem({
      level: 'info',
      eventType: SystemEventType.DATA_COLLECTION_START,
      message: 'Data collection service initialized',
      component: 'DataCollectorService',
    });
  }

  /**
   * Start collecting data for given symbols
   */
  async startCollection(symbols: string[]): Promise<void> {
    this.symbols = symbols;
    this.logger.log(`Starting data collection for ${symbols.length} symbols`, 'DataCollectorService');

    for (const symbol of symbols) {
      await this.connectWebSocket(symbol);
    }

    // Also fetch initial historical data
    for (const symbol of symbols) {
      await this.fetchHistoricalData(symbol);
    }

    // Fetch initial funding rates
    this.logger.log('Fetching initial funding rates for all symbols...', 'DataCollectorService');
    for (const symbol of symbols) {
      await this.fetchAndCacheFundingRate(symbol);
    }

    // Update funding rates every hour (funding updates every 8h, but we check more frequently)
    setInterval(async () => {
      for (const symbol of this.symbols) {
        await this.fetchAndCacheFundingRate(symbol);
      }
    }, 3600000); // 1 hour
  }

  /**
   * Connect WebSocket for a symbol (all timeframes)
   */
  private async connectWebSocket(symbol: string): Promise<void> {
    const baseUrl = this.isTestnet
      ? 'wss://testnet.binance.vision/ws'
      : 'wss://fstream.binance.com/ws';

    // Create streams for all timeframes
    const streams = this.timeframes.map(tf => `${symbol.toLowerCase()}@kline_${tf}`);
    const streamUrl = `${baseUrl}/${streams.join('/')}`;

    try {
      const ws = new WebSocket(streamUrl);

      ws.on('open', () => {
        this.logger.log(`WebSocket connected for ${symbol}`, 'DataCollectorService');
        this.logger.logSystem({
          level: 'info',
          eventType: SystemEventType.WEBSOCKET_CONNECT,
          message: `WebSocket connected for ${symbol}`,
          component: 'DataCollectorService',
          metadata: { symbol, timeframes: this.timeframes },
        });
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const message = JSON.parse(data.toString()) as BinanceKline;
          if (message.e === 'kline') {
            await this.handleKlineUpdate(message);
          }
        } catch (error) {
          this.logger.error(`Failed to parse WebSocket message: ${error.message}`, error.stack, 'DataCollectorService');
        }
      });

      ws.on('error', (error) => {
        this.logger.error(`WebSocket error for ${symbol}: ${error.message}`, error.stack, 'DataCollectorService');
        this.logger.logSystem({
          level: 'error',
          eventType: SystemEventType.WEBSOCKET_ERROR,
          message: `WebSocket error for ${symbol}`,
          component: 'DataCollectorService',
          metadata: { symbol, error: error.message },
        });
      });

      ws.on('close', () => {
        this.logger.warn(`WebSocket closed for ${symbol}, reconnecting...`, 'DataCollectorService');
        this.logger.logSystem({
          level: 'warn',
          eventType: SystemEventType.WEBSOCKET_DISCONNECT,
          message: `WebSocket disconnected for ${symbol}`,
          component: 'DataCollectorService',
          metadata: { symbol },
        });

        // Reconnect after 5 seconds
        setTimeout(() => this.connectWebSocket(symbol), 5000);
      });

      this.wsConnections.set(symbol, ws);
    } catch (error) {
      this.logger.error(`Failed to connect WebSocket for ${symbol}: ${error.message}`, error.stack, 'DataCollectorService');
      await this.logger.logSystem({
        level: 'error',
        eventType: SystemEventType.WEBSOCKET_ERROR,
        message: `Failed to connect WebSocket for ${symbol}`,
        component: 'DataCollectorService',
        metadata: { symbol, error: error.message },
      });
    }
  }

  /**
   * Handle incoming kline update
   */
  private async handleKlineUpdate(message: BinanceKline): Promise<void> {
    const candle: Candle = {
      symbol: message.k.s,
      timeframe: message.k.i as Timeframe,
      openTime: message.k.t,
      closeTime: message.k.T,
      open: parseFloat(message.k.o),
      high: parseFloat(message.k.h),
      low: parseFloat(message.k.l),
      close: parseFloat(message.k.c),
      volume: parseFloat(message.k.v),
      trades: message.k.n,
    };

    // Only cache closed candles
    if (message.k.x) {
      await this.cacheService.addCandle(candle.symbol, candle.timeframe as any, candle);
      this.logger.debug(`Cached ${candle.timeframe} candle for ${candle.symbol}`, 'DataCollectorService');

      // Check for inactive symbols (15m candles only)
      if (candle.timeframe === '15m') {
        await this.checkSymbolActivity(candle);
      }

      // CRITICAL: Emit event immediately on candle close (< 0.1s reaction time)
      // This breaks the "1-minute wall" - no more waiting for cron!
      if (candle.timeframe === '15m' || candle.timeframe === '1h' || candle.timeframe === '4h' || candle.timeframe === '1d') {
        const event = new CandleClosedEvent(
          candle.symbol,
          candle.timeframe,
          candle.closeTime,
          candle.close,
          candle.volume,
        );
        this.eventEmitter.emit('candle.closed', event);

        this.logger.debug(
          `🚨 Candle closed event emitted: ${candle.symbol} ${candle.timeframe} @ ${candle.close}`,
          'DataCollectorService',
        );
      }

      // 1분봉 이벤트 발생 (Box Range 및 Funding Extremes 실시간 진입용)
      if (candle.timeframe === '1m') {
        const event = new CandleClosedEvent(
          candle.symbol,
          candle.timeframe,
          candle.closeTime,
          candle.close,
          candle.volume,
        );
        // 별도 이벤트로 발생하여 15m/1h와 분리
        this.eventEmitter.emit('candle.closed.1m', event);

        // 로그는 orchestrator에서 필터링 후 출력 (여기선 생략)
      }
    }

    // Always update current price
    await this.cacheService.setCurrentPrice(candle.symbol, candle.close);
  }

  /**
   * Check if symbol is inactive (zero volume)
   * If symbol has consecutive zero-volume candles, emit event for replacement
   */
  private async checkSymbolActivity(candle: Candle): Promise<void> {
    const symbol = candle.symbol;
    const volume = candle.volume;

    // Initialize counter if not exists
    if (!this.zeroVolumeCount.has(symbol)) {
      this.zeroVolumeCount.set(symbol, 0);
    }

    if (volume === 0 || (candle.high === candle.low && candle.open === candle.close)) {
      // Zero volume or no price movement
      const count = this.zeroVolumeCount.get(symbol)! + 1;
      this.zeroVolumeCount.set(symbol, count);

      this.logger.debug(
        `${symbol}: Zero volume candle detected (count: ${count}/${this.MAX_ZERO_VOLUME_CANDLES})`,
        'DataCollectorService',
      );

      // If too many consecutive zero-volume candles, mark as inactive
      if (count >= this.MAX_ZERO_VOLUME_CANDLES) {
        this.logger.warn(
          `🚫 ${symbol}: Inactive symbol detected (${count} consecutive zero-volume candles). Requesting replacement...`,
          'DataCollectorService',
        );

        // Emit event for orchestrator to replace this symbol
        this.eventEmitter.emit('symbol.inactive', { symbol });

        // Remove symbol from collection
        await this.stopSymbolCollection(symbol);

        // Reset counter
        this.zeroVolumeCount.delete(symbol);
      }
    } else {
      // Symbol has volume, reset counter
      if (this.zeroVolumeCount.get(symbol)! > 0) {
        this.logger.debug(
          `${symbol}: Volume resumed, resetting zero-volume counter`,
          'DataCollectorService',
        );
      }
      this.zeroVolumeCount.set(symbol, 0);
    }
  }

  /**
   * Stop collection for a single symbol
   */
  async stopSymbolCollection(symbol: string): Promise<void> {
    const ws = this.wsConnections.get(symbol);
    if (ws) {
      ws.close();
      this.wsConnections.delete(symbol);
      this.logger.log(`Stopped WebSocket for inactive symbol: ${symbol}`, 'DataCollectorService');
    }

    // Remove from symbols list
    const index = this.symbols.indexOf(symbol);
    if (index !== -1) {
      this.symbols.splice(index, 1);
    }

    // Clean up counter
    this.zeroVolumeCount.delete(symbol);
  }

  /**
   * Refresh symbols list (called by Orchestrator at session times)
   * Keeps symbols with active positions, replaces rest with new top symbols
   */
  async refreshSymbols(newSymbols: string[], keepSymbols: string[]): Promise<void> {
    this.logger.log(
      `🔄 [Symbol Refresh] Starting refresh: ${newSymbols.length} new symbols, keeping ${keepSymbols.length} active position symbols`,
      'DataCollectorService',
    );

    // Build final symbol list: keep active position symbols + new symbols
    const finalSymbols = [...keepSymbols];
    for (const symbol of newSymbols) {
      if (!finalSymbols.includes(symbol) && finalSymbols.length < 100) {
        finalSymbols.push(symbol);
      }
    }

    // Find symbols to remove and add
    const toRemove = this.symbols.filter(s => !finalSymbols.includes(s));
    const toAdd = finalSymbols.filter(s => !this.symbols.includes(s));

    this.logger.log(
      `[Symbol Refresh] Removing ${toRemove.length} symbols, adding ${toAdd.length} symbols`,
      'DataCollectorService',
    );

    // Close WebSockets for removed symbols
    for (const symbol of toRemove) {
      const ws = this.wsConnections.get(symbol);
      if (ws) {
        ws.close();
        this.wsConnections.delete(symbol);
      }
      this.zeroVolumeCount.delete(symbol);
    }

    // Update symbols list
    this.symbols = finalSymbols;

    // Connect WebSockets for new symbols
    for (const symbol of toAdd) {
      await this.connectWebSocket(symbol);
      await this.fetchHistoricalData(symbol);
      await this.fetchAndCacheFundingRate(symbol);
    }

    this.logger.log(
      `✅ [Symbol Refresh] Complete. Now tracking ${this.symbols.length} symbols`,
      'DataCollectorService',
    );
  }

  /**
   * Get currently tracked symbols
   */
  getTrackedSymbols(): string[] {
    return [...this.symbols];
  }

  /**
   * Add a new symbol to collection (used for replacement)
   */
  async addSymbol(symbol: string): Promise<void> {
    if (this.symbols.includes(symbol)) {
      this.logger.debug(`${symbol} already being tracked`, 'DataCollectorService');
      return;
    }

    this.logger.log(`Adding new symbol to collection: ${symbol}`, 'DataCollectorService');
    this.symbols.push(symbol);

    await this.connectWebSocket(symbol);
    await this.fetchHistoricalData(symbol);
    await this.fetchAndCacheFundingRate(symbol);
  }

  /**
   * Fetch historical candle data
   */
  private async fetchHistoricalData(symbol: string): Promise<void> {
    const baseUrl = this.isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    for (const timeframe of this.timeframes) {
      try {
        const limit = this.getHistoricalLimit(timeframe);
        const url = `${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const candles: Candle[] = data.map((k: any) => ({
          symbol,
          timeframe,
          openTime: k[0],
          closeTime: k[6],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          trades: k[8],
        }));

        await this.cacheService.setCandles(symbol, timeframe, candles);
        this.logger.log(`Fetched ${candles.length} historical ${timeframe} candles for ${symbol}`, 'DataCollectorService');
      } catch (error) {
        this.logger.error(`Failed to fetch historical data for ${symbol} ${timeframe}: ${error.message}`, error.stack, 'DataCollectorService');
        await this.logger.logSystem({
          level: 'error',
          eventType: SystemEventType.DATA_COLLECTION_ERROR,
          message: `Failed to fetch historical data`,
          component: 'DataCollectorService',
          metadata: { symbol, timeframe, error: error.message },
        });
      }
    }
  }

  /**
   * Get historical candle limit based on timeframe
   * Note: 1d increased to 250 for EMA 200 calculation (Core Trend strategy)
   */
  private getHistoricalLimit(timeframe: Timeframe): number {
    const limits = {
      '1m': 120,   // 2 hours
      '5m': 120,   // 10 hours
      '15m': 100,  // 25 hours (enough for Squeeze strategy)
      '1h': 100,   // 100 hours
      '4h': 150,   // 600 hours (~25 days, for Core Trend)
      '1d': 250,   // 250 days (for EMA 200 calculation in Core Trend)
    };
    return limits[timeframe] || 100;
  }

  /**
   * Fetch and cache funding rate for a symbol
   */
  private async fetchAndCacheFundingRate(symbol: string): Promise<void> {
    try {
      await this.fetchFundingRate(symbol);
    } catch (error) {
      // Error already logged in fetchFundingRate
    }
  }

  /**
   * Fetch current funding rate
   */
  async fetchFundingRate(symbol: string): Promise<number> {
    const baseUrl = this.isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    try {
      const url = `${baseUrl}/fapi/v1/premiumIndex?symbol=${symbol}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const fundingRate = parseFloat(data.lastFundingRate);

      await this.cacheService.setFundingRate(symbol, fundingRate);
      return fundingRate;
    } catch (error) {
      this.logger.error(`Failed to fetch funding rate for ${symbol}: ${error.message}`, error.stack, 'DataCollectorService');
      return 0;
    }
  }

  /**
   * Stop all data collection
   */
  async stopCollection(): Promise<void> {
    this.logger.log('Stopping data collection', 'DataCollectorService');

    for (const [symbol, ws] of this.wsConnections) {
      ws.close();
      this.logger.log(`Closed WebSocket for ${symbol}`, 'DataCollectorService');
    }

    this.wsConnections.clear();
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    await this.stopCollection();
  }
}
