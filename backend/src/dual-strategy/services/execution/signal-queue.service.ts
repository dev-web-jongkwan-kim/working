import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { DataCacheService } from '../data/data-cache.service';
import { TradingSignal } from '../../interfaces/signal.interface';
import { MarketRegime } from '../../../entities/market-regime-history.entity';

/**
 * Queued signal structure
 */
interface QueuedSignal {
  signal: TradingSignal;
  symbol: string;
  direction: string;
  regime: MarketRegime;
  createdAt: number;
  priority: number; // 1 = highest (trend-following), 3 = lowest (counter-trend)
}

/**
 * Signal Queue Service
 * Manages time-delayed signal processing with deduplication
 *
 * Key features:
 * - Redis-based queue (survives restarts with TTL expiry)
 * - Deduplication by symbol (1 signal per symbol)
 * - Regime-based priority (trend-following first)
 * - Staggered entry (2-minute intervals)
 * - Re-validation before entry
 */
@Injectable()
export class SignalQueueService {
  private readonly QUEUE_KEY_PREFIX = 'signal_queue:';
  private readonly QUEUE_INDEX_KEY = 'signal_queue:index';
  private readonly SIGNAL_TTL_SECONDS = 300; // 5 minutes
  private readonly PROCESSING_INTERVAL_MS = 120000; // 2 minutes
  private readonly MAX_PRICE_DEVIATION_PERCENT = 1.0; // 1% max price change

  private lastProcessedTime: number = 0;
  private isProcessing: boolean = false;

  constructor(
    private readonly logger: CustomLoggerService,
    private readonly cacheService: DataCacheService,
  ) {}

  /**
   * Add signal to queue (with deduplication)
   * Returns true if added, false if duplicate
   */
  async addToQueue(
    signal: TradingSignal,
    symbol: string,
    regime: MarketRegime,
  ): Promise<boolean> {
    const key = this.QUEUE_KEY_PREFIX + symbol;

    // Check if already in queue
    const existing = await this.cacheService.client.get(key);
    if (existing) {
      this.logger.debug(
        `[SignalQueue] ${symbol} already in queue, skipping duplicate`,
        'SignalQueueService',
      );
      return false;
    }

    // Calculate priority based on regime alignment
    const priority = this.calculatePriority(signal.direction, regime);

    const queuedSignal: QueuedSignal = {
      signal,
      symbol,
      direction: signal.direction,
      regime,
      createdAt: Date.now(),
      priority,
    };

    // Add to Redis with TTL
    await this.cacheService.client.set(key, JSON.stringify(queuedSignal), {
      EX: this.SIGNAL_TTL_SECONDS,
    });

    // Add to index set for tracking
    await this.cacheService.client.sAdd(this.QUEUE_INDEX_KEY, symbol);
    await this.cacheService.client.expire(this.QUEUE_INDEX_KEY, this.SIGNAL_TTL_SECONDS);

    const priorityLabel = priority === 1 ? 'HIGH (trend-following)' :
                         priority === 2 ? 'MEDIUM' : 'LOW (counter-trend)';

    this.logger.log(
      `[SignalQueue] Added ${symbol} ${signal.direction} to queue (priority: ${priorityLabel}, regime: ${regime})`,
      'SignalQueueService',
    );

    return true;
  }

  /**
   * Get next signal to process (highest priority, oldest first)
   * Uses GETDEL for atomic get-and-delete
   */
  async getNextSignal(): Promise<QueuedSignal | null> {
    // Get all queued symbols
    const symbols = await this.cacheService.client.sMembers(this.QUEUE_INDEX_KEY);

    if (!symbols || symbols.length === 0) {
      return null;
    }

    // Get all signals and sort by priority, then by age
    const signals: QueuedSignal[] = [];
    for (const symbol of symbols) {
      const key = this.QUEUE_KEY_PREFIX + symbol;
      const data = await this.cacheService.client.get(key);
      if (data) {
        try {
          signals.push(JSON.parse(data));
        } catch (e) {
          // Invalid data, clean up
          await this.removeFromQueue(symbol);
        }
      } else {
        // Key expired, remove from index
        await this.cacheService.client.sRem(this.QUEUE_INDEX_KEY, symbol);
      }
    }

    if (signals.length === 0) {
      return null;
    }

    // Sort: priority ASC (1 first), then createdAt ASC (oldest first)
    signals.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return a.createdAt - b.createdAt;
    });

    const nextSignal = signals[0];

    // Atomic delete (prevent duplicate processing)
    const key = this.QUEUE_KEY_PREFIX + nextSignal.symbol;
    const deleted = await this.cacheService.client.del(key);
    await this.cacheService.client.sRem(this.QUEUE_INDEX_KEY, nextSignal.symbol);

    if (deleted === 0) {
      // Already processed by another instance
      this.logger.debug(
        `[SignalQueue] ${nextSignal.symbol} already processed, skipping`,
        'SignalQueueService',
      );
      return null;
    }

    this.logger.log(
      `[SignalQueue] Dequeued ${nextSignal.symbol} ${nextSignal.direction} for processing`,
      'SignalQueueService',
    );

    return nextSignal;
  }

  /**
   * Remove signal from queue
   */
  async removeFromQueue(symbol: string): Promise<void> {
    const key = this.QUEUE_KEY_PREFIX + symbol;
    await this.cacheService.client.del(key);
    await this.cacheService.client.sRem(this.QUEUE_INDEX_KEY, symbol);
    this.logger.debug(`[SignalQueue] Removed ${symbol} from queue`, 'SignalQueueService');
  }

  /**
   * Check if enough time has passed for next processing
   */
  canProcessNext(): boolean {
    const now = Date.now();
    return now - this.lastProcessedTime >= this.PROCESSING_INTERVAL_MS;
  }

  /**
   * Mark processing started
   */
  markProcessingStarted(): boolean {
    if (this.isProcessing) {
      return false; // Already processing
    }
    this.isProcessing = true;
    return true;
  }

  /**
   * Mark processing completed
   */
  markProcessingCompleted(): void {
    this.isProcessing = false;
    this.lastProcessedTime = Date.now();
  }

  /**
   * Get queue size
   */
  async getQueueSize(): Promise<number> {
    const size = await this.cacheService.client.sCard(this.QUEUE_INDEX_KEY);
    return size || 0;
  }

  /**
   * Get all queued symbols (for debugging)
   */
  async getQueuedSymbols(): Promise<string[]> {
    const symbols = await this.cacheService.client.sMembers(this.QUEUE_INDEX_KEY);
    return symbols || [];
  }

  /**
   * Clear entire queue (on startup or emergency)
   */
  async clearQueue(): Promise<void> {
    const symbols = await this.cacheService.client.sMembers(this.QUEUE_INDEX_KEY);

    if (symbols && symbols.length > 0) {
      for (const symbol of symbols) {
        await this.cacheService.client.del(this.QUEUE_KEY_PREFIX + symbol);
      }
      await this.cacheService.client.del(this.QUEUE_INDEX_KEY);

      this.logger.log(
        `[SignalQueue] Cleared ${symbols.length} signals from queue`,
        'SignalQueueService',
      );
    }
  }

  /**
   * Validate signal is still valid for entry
   */
  async validateSignalForEntry(
    queuedSignal: QueuedSignal,
    currentPrice: number,
    currentRegime: MarketRegime,
  ): Promise<{ valid: boolean; reason?: string }> {
    const { signal, createdAt, regime } = queuedSignal;

    // 1. Check if expired (should not happen due to TTL, but double-check)
    const ageMs = Date.now() - createdAt;
    if (ageMs > this.SIGNAL_TTL_SECONDS * 1000) {
      return { valid: false, reason: 'Signal expired' };
    }

    // 2. Check price deviation
    const priceDeviation = Math.abs(currentPrice - signal.entryPrice) / signal.entryPrice * 100;
    if (priceDeviation > this.MAX_PRICE_DEVIATION_PERCENT) {
      return {
        valid: false,
        reason: `Price moved ${priceDeviation.toFixed(2)}% (max ${this.MAX_PRICE_DEVIATION_PERCENT}%)`
      };
    }

    // 3. Check regime change (allow if same or better for direction)
    if (regime !== currentRegime) {
      const stillValid = this.isRegimeStillValid(signal.direction, regime, currentRegime);
      if (!stillValid) {
        return {
          valid: false,
          reason: `Regime changed: ${regime} → ${currentRegime}`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Calculate priority based on regime alignment
   * 1 = Trend-following (highest priority)
   * 2 = Neutral
   * 3 = Counter-trend (lowest priority)
   */
  private calculatePriority(direction: string, regime: MarketRegime): number {
    // Trend-following (high priority)
    if (
      (direction === 'LONG' && (regime === MarketRegime.STRONG_UPTREND || regime === MarketRegime.WEAK_UPTREND)) ||
      (direction === 'SHORT' && (regime === MarketRegime.STRONG_DOWNTREND || regime === MarketRegime.WEAK_DOWNTREND))
    ) {
      return 1;
    }

    // Counter-trend (low priority)
    if (
      (direction === 'LONG' && (regime === MarketRegime.STRONG_DOWNTREND || regime === MarketRegime.WEAK_DOWNTREND)) ||
      (direction === 'SHORT' && (regime === MarketRegime.STRONG_UPTREND || regime === MarketRegime.WEAK_UPTREND))
    ) {
      return 3;
    }

    // Neutral
    return 2;
  }

  /**
   * Check if regime change still allows the trade
   */
  private isRegimeStillValid(
    direction: string,
    originalRegime: MarketRegime,
    currentRegime: MarketRegime,
  ): boolean {
    // If regime improved for our direction, still valid
    if (direction === 'LONG') {
      const regimeOrder = [
        MarketRegime.STRONG_DOWNTREND,
        MarketRegime.WEAK_DOWNTREND,
        MarketRegime.SIDEWAYS,
        MarketRegime.WEAK_UPTREND,
        MarketRegime.STRONG_UPTREND,
      ];
      const originalIdx = regimeOrder.indexOf(originalRegime);
      const currentIdx = regimeOrder.indexOf(currentRegime);
      return currentIdx >= originalIdx; // Same or better for LONG
    } else {
      // SHORT
      const regimeOrder = [
        MarketRegime.STRONG_UPTREND,
        MarketRegime.WEAK_UPTREND,
        MarketRegime.SIDEWAYS,
        MarketRegime.WEAK_DOWNTREND,
        MarketRegime.STRONG_DOWNTREND,
      ];
      const originalIdx = regimeOrder.indexOf(originalRegime);
      const currentIdx = regimeOrder.indexOf(currentRegime);
      return currentIdx >= originalIdx; // Same or better for SHORT
    }
  }

  /**
   * Get regime-based max concurrent entries
   */
  getMaxConcurrentEntries(direction: string, regime: MarketRegime): number {
    // Trend-following: allow more
    if (
      (direction === 'LONG' && regime === MarketRegime.STRONG_UPTREND) ||
      (direction === 'SHORT' && regime === MarketRegime.STRONG_DOWNTREND)
    ) {
      return 3;
    }

    // Weak trend-following
    if (
      (direction === 'LONG' && regime === MarketRegime.WEAK_UPTREND) ||
      (direction === 'SHORT' && regime === MarketRegime.WEAK_DOWNTREND)
    ) {
      return 2;
    }

    // Sideways
    if (regime === MarketRegime.SIDEWAYS) {
      return 2;
    }

    // Counter-trend: strict limit
    return 1;
  }
}
