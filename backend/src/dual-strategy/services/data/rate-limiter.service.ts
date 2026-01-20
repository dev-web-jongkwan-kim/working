import { Injectable, Logger } from '@nestjs/common';

interface RequestRecord {
  timestamp: number;
  weight: number;
}

/**
 * API Rate Limiter Service
 * Prevents hitting Binance API rate limits
 * - 2400 weight per minute
 * - 20 requests per second (simplified)
 */
@Injectable()
export class RateLimiterService {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly requests: RequestRecord[] = [];
  private readonly MAX_WEIGHT_PER_MINUTE = 2400;
  private readonly MAX_REQUESTS_PER_SECOND = 20;
  private readonly MINUTE_MS = 60 * 1000;
  private readonly SECOND_MS = 1000;

  /**
   * Check if a request can be made
   * @param weight - API weight of the request (default 1)
   * @returns Promise that resolves when request can be made
   */
  async checkRateLimit(weight: number = 1): Promise<void> {
    const now = Date.now();

    // Clean up old requests (older than 1 minute)
    this.cleanupOldRequests(now);

    // Check if we can make the request
    while (!this.canMakeRequest(now, weight)) {
      // Wait a bit and retry
      await this.sleep(100);
      this.cleanupOldRequests(Date.now());
    }

    // Record this request
    this.requests.push({ timestamp: now, weight });
  }

  /**
   * Check if request can be made without waiting
   */
  private canMakeRequest(now: number, weight: number): boolean {
    // Check requests per second
    const recentRequests = this.requests.filter(
      r => now - r.timestamp < this.SECOND_MS,
    );

    if (recentRequests.length >= this.MAX_REQUESTS_PER_SECOND) {
      this.logger.debug(
        `Rate limit: ${recentRequests.length} requests in last second, waiting...`,
      );
      return false;
    }

    // Check weight per minute
    const recentWeight = this.requests
      .filter(r => now - r.timestamp < this.MINUTE_MS)
      .reduce((sum, r) => sum + r.weight, 0);

    if (recentWeight + weight > this.MAX_WEIGHT_PER_MINUTE) {
      this.logger.debug(
        `Rate limit: ${recentWeight}/${this.MAX_WEIGHT_PER_MINUTE} weight used in last minute, waiting...`,
      );
      return false;
    }

    return true;
  }

  /**
   * Clean up requests older than 1 minute
   */
  private cleanupOldRequests(now: number): void {
    const cutoff = now - this.MINUTE_MS;
    const before = this.requests.length;

    // Remove old requests
    while (this.requests.length > 0 && this.requests[0].timestamp < cutoff) {
      this.requests.shift();
    }

    const removed = before - this.requests.length;
    if (removed > 0) {
      this.logger.debug(`Cleaned up ${removed} old request records`);
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current rate limit status
   */
  getStatus(): {
    requestsLastSecond: number;
    weightLastMinute: number;
    remainingWeight: number;
    remainingRequests: number;
  } {
    const now = Date.now();
    this.cleanupOldRequests(now);

    const requestsLastSecond = this.requests.filter(
      r => now - r.timestamp < this.SECOND_MS,
    ).length;

    const weightLastMinute = this.requests
      .filter(r => now - r.timestamp < this.MINUTE_MS)
      .reduce((sum, r) => sum + r.weight, 0);

    return {
      requestsLastSecond,
      weightLastMinute,
      remainingWeight: this.MAX_WEIGHT_PER_MINUTE - weightLastMinute,
      remainingRequests: this.MAX_REQUESTS_PER_SECOND - requestsLastSecond,
    };
  }
}
