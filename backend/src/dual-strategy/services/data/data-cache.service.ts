import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { SystemEventType } from '../../../entities/system-log.entity';
import { Candle, Timeframe } from '../../interfaces/candle.interface';

/**
 * Redis Cache Service for storing candle data
 * Implements efficient caching strategy with TTL
 */
@Injectable()
export class DataCacheService implements OnModuleInit {
  public client: RedisClientType; // Public for RiskManager access

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onModuleInit() {
    await this.connectRedis();
  }

  /**
   * Connect to Redis with automatic reconnection
   * CRITICAL: Handles reconnection on failure
   */
  private async connectRedis(): Promise<void> {
    const redisHost = this.configService.get('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get('REDIS_PORT', 6379);

    this.client = createClient({
      url: `redis://${redisHost}:${redisPort}`,
      socket: {
        reconnectStrategy: (retries) => {
          // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
          const delay = Math.min(1000 * Math.pow(2, retries), 30000);
          this.logger.log(`Redis reconnecting in ${delay}ms (attempt ${retries + 1})`, 'DataCacheService');
          return delay;
        },
      },
    });

    this.client.on('error', async (err) => {
      this.logger.error(`Redis Client Error: ${err.message}`, err.stack, 'DataCacheService');
      await this.logger.logSystem({
        level: 'error',
        eventType: SystemEventType.REDIS_ERROR,
        message: 'Redis connection error',
        component: 'DataCacheService',
        metadata: { error: err.message },
      });
    });

    this.client.on('connect', async () => {
      this.logger.log('Redis connected successfully', 'DataCacheService');
      await this.logger.logSystem({
        level: 'info',
        eventType: SystemEventType.REDIS_CONNECT,
        message: 'Redis connected',
        component: 'DataCacheService',
        metadata: { host: redisHost, port: redisPort },
      });
    });

    this.client.on('reconnecting', () => {
      this.logger.log('Redis reconnecting...', 'DataCacheService');
    });

    this.client.on('ready', () => {
      this.logger.log('Redis client ready', 'DataCacheService');
    });

    try {
      await this.client.connect();
    } catch (error) {
      this.logger.error(`Failed to connect to Redis: ${error.message}`, error.stack, 'DataCacheService');
      // Don't throw - let reconnectStrategy handle it
    }
  }

  /**
   * Get cache key for candles
   */
  private getCandleKey(symbol: string, timeframe: Timeframe): string {
    return `candles:${timeframe}:${symbol}`;
  }

  /**
   * Store candles in Redis (keeping only recent data)
   */
  async setCandles(symbol: string, timeframe: Timeframe, candles: Candle[]): Promise<void> {
    const key = this.getCandleKey(symbol, timeframe);
    try {
      await this.client.set(key, JSON.stringify(candles), {
        EX: this.getTTL(timeframe), // TTL based on timeframe
      });
    } catch (error) {
      this.logger.error(`Failed to cache candles: ${error.message}`, error.stack, 'DataCacheService');
    }
  }

  /**
   * Get candles from Redis
   */
  async getCandles(symbol: string, timeframe: Timeframe): Promise<Candle[] | null> {
    const key = this.getCandleKey(symbol, timeframe);
    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (error) {
      this.logger.error(`Failed to get candles: ${error.message}`, error.stack, 'DataCacheService');
      return null;
    }
  }

  /**
   * Add a new candle to existing cache
   */
  async addCandle(symbol: string, timeframe: Timeframe, candle: Candle): Promise<void> {
    const existingCandles = await this.getCandles(symbol, timeframe) || [];

    // Remove oldest candle if exceeding limit
    const limit = this.getMaxCandles(timeframe);
    if (existingCandles.length >= limit) {
      existingCandles.shift();
    }

    // Add new candle
    existingCandles.push(candle);
    await this.setCandles(symbol, timeframe, existingCandles);
  }

  /**
   * Get recent N candles
   */
  async getRecentCandles(symbol: string, timeframe: Timeframe, count: number): Promise<Candle[]> {
    const candles = await this.getCandles(symbol, timeframe);
    if (!candles) return [];
    return candles.slice(-count);
  }

  /**
   * Store current price
   */
  async setCurrentPrice(symbol: string, price: number): Promise<void> {
    const key = `price:${symbol}`;
    try {
      await this.client.set(key, price.toString(), { EX: 60 }); // 1 minute TTL
    } catch (error) {
      this.logger.error(`Failed to cache price: ${error.message}`, error.stack, 'DataCacheService');
    }
  }

  /**
   * Get current price
   */
  async getCurrentPrice(symbol: string): Promise<number | null> {
    const key = `price:${symbol}`;
    try {
      const price = await this.client.get(key);
      return price ? parseFloat(price) : null;
    } catch (error) {
      this.logger.error(`Failed to get price: ${error.message}`, error.stack, 'DataCacheService');
      return null;
    }
  }

  /**
   * Store funding rate
   */
  async setFundingRate(symbol: string, rate: number): Promise<void> {
    const key = `funding:${symbol}`;
    try {
      await this.client.set(key, rate.toString(), { EX: 3600 }); // 1 hour TTL
    } catch (error) {
      this.logger.error(`Failed to cache funding rate: ${error.message}`, error.stack, 'DataCacheService');
    }
  }

  /**
   * Get funding rate
   */
  async getFundingRate(symbol: string): Promise<number | null> {
    const key = `funding:${symbol}`;
    try {
      const rate = await this.client.get(key);
      return rate ? parseFloat(rate) : null;
    } catch (error) {
      this.logger.error(`Failed to get funding rate: ${error.message}`, error.stack, 'DataCacheService');
      return null;
    }
  }

  /**
   * Store funding rate history
   */
  async addFundingHistory(symbol: string, rate: number): Promise<void> {
    const key = `funding_history:${symbol}`;
    try {
      // Push to list (max 200 items for percentile calculation)
      await this.client.rPush(key, rate.toString());
      await this.client.lTrim(key, -200, -1);
      await this.client.expire(key, 7 * 24 * 3600); // 7 days TTL
    } catch (error) {
      this.logger.error(`Failed to add funding history: ${error.message}`, error.stack, 'DataCacheService');
    }
  }

  /**
   * Get funding rate history
   */
  async getFundingHistory(symbol: string, count: number = 200): Promise<number[]> {
    const key = `funding_history:${symbol}`;
    try {
      const data = await this.client.lRange(key, -count, -1);
      return data.map((r) => parseFloat(r));
    } catch (error) {
      this.logger.error(`Failed to get funding history: ${error.message}`, error.stack, 'DataCacheService');
      return [];
    }
  }

  /**
   * Initialize funding history from API data
   */
  async initializeFundingHistory(symbol: string, rates: number[]): Promise<void> {
    const key = `funding_history:${symbol}`;
    try {
      // Clear existing
      await this.client.del(key);
      // Add all rates
      if (rates.length > 0) {
        const stringRates = rates.map((r) => r.toString());
        await this.client.rPush(key, stringRates);
        await this.client.expire(key, 7 * 24 * 3600);
      }
    } catch (error) {
      this.logger.error(`Failed to initialize funding history: ${error.message}`, error.stack, 'DataCacheService');
    }
  }

  /**
   * Clear all cache for a symbol
   */
  async clearSymbolCache(symbol: string): Promise<void> {
    const patterns = [
      `candles:*:${symbol}`,
      `price:${symbol}`,
      `funding:${symbol}`,
    ];

    try {
      for (const pattern of patterns) {
        const keys = await this.client.keys(pattern);
        if (keys.length > 0) {
          await this.client.del(keys);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to clear cache: ${error.message}`, error.stack, 'DataCacheService');
    }
  }

  /**
   * Get TTL based on timeframe
   */
  private getTTL(timeframe: Timeframe): number {
    const ttls = {
      '1m': 3600,      // 1 hour
      '5m': 7200,      // 2 hours
      '15m': 14400,    // 4 hours
      '1h': 86400,     // 24 hours
      '4h': 172800,    // 48 hours
      '1d': 604800,    // 7 days
    };
    return ttls[timeframe] || 3600;
  }

  /**
   * Get max candles to keep based on timeframe
   */
  private getMaxCandles(timeframe: Timeframe): number {
    const limits = {
      '1m': 120,   // 2 hours (enough for indicators)
      '5m': 120,   // 10 hours (enough for Cycle Rider)
      '15m': 120,  // 30 hours (enough for Box Range 100 + buffer)
      '1h': 100,   // 100 hours (enough for Hour Swing)
      '4h': 100,   // 400 hours
      '1d': 50,    // 50 days
    };
    return limits[timeframe] || 120;
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
