import { Injectable } from '@nestjs/common';
import { AccumulationDetectorService } from './accumulation-detector.service';
import { DistributionDetectorService } from './distribution-detector.service';
import { DivergenceAnalyzerService } from './divergence-analyzer.service';
import { VolumeClimaxDetectorService } from './volume-climax-detector.service';
import { SqueezeDetectorService } from './squeeze-detector.service';
import { DataCacheService } from '../data/data-cache.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { TradingSignal } from '../../interfaces/signal.interface';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { Indicators } from '../../utils/indicators';
import { MarketRegime } from '../../../entities/market-regime-history.entity';

/**
 * Cycle Rider Signal Service
 * Integrates all sub-strategies and applies common filters
 */
@Injectable()
export class CycleRiderSignalService {
  private readonly config = CYCLE_RIDER_CONFIG;

  constructor(
    private readonly accumulationDetector: AccumulationDetectorService,
    private readonly distributionDetector: DistributionDetectorService,
    private readonly divergenceAnalyzer: DivergenceAnalyzerService,
    private readonly volumeClimaxDetector: VolumeClimaxDetectorService,
    private readonly squeezeDetector: SqueezeDetectorService,
    private readonly cacheService: DataCacheService,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Generate signal for a symbol
   */
  async generateSignal(symbol: string, regime: MarketRegime): Promise<TradingSignal | null> {
    try {
      // Get candle data
      const candles = await this.cacheService.getRecentCandles(symbol, '15m', 60);
      if (!candles || candles.length < 50) {
        this.logger.debug(`Insufficient candle data for ${symbol}`, 'CycleRiderSignalService');
        return null;
      }

      const currentPrice = await this.cacheService.getCurrentPrice(symbol);
      if (!currentPrice) {
        this.logger.debug(`No current price for ${symbol}`, 'CycleRiderSignalService');
        return null;
      }

      // Apply common filters first (CRITICAL!)
      const filterResult = await this.applyCommonFilters(symbol, candles, currentPrice);
      if (!filterResult.passed) {
        this.logger.debug(
          `Common filter failed for ${symbol}: ${filterResult.reason}`,
          'CycleRiderSignalService',
        );
        return null;
      }

      // Try each sub-strategy in priority order
      const strategies = [
        { name: 'accumulation', detector: this.accumulationDetector },
        { name: 'distribution', detector: this.distributionDetector },
        { name: 'divergence', detector: this.divergenceAnalyzer },
        { name: 'volumeClimax', detector: this.volumeClimaxDetector },
        { name: 'squeeze', detector: this.squeezeDetector },
      ];

      for (const strategy of strategies) {
        const signal = await strategy.detector.detect(candles, currentPrice);

        if (signal.detected) {
          // Apply consecutive bar filter (CRITICAL!)
          const consecutiveBarCheck = this.checkConsecutiveBars(candles, signal.direction);
          if (!consecutiveBarCheck.passed) {
            this.logger.debug(
              `Consecutive bar filter failed for ${symbol} ${strategy.name}: ${consecutiveBarCheck.reason}`,
              'CycleRiderSignalService',
            );
            continue;
          }

          // Add market regime to signal
          signal.marketRegime = regime;

          this.logger.log(
            `Signal generated: ${signal.subStrategy} for ${symbol} ${signal.direction}`,
            'CycleRiderSignalService',
          );

          return signal;
        }
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Error generating signal for ${symbol}: ${error.message}`,
        error.stack,
        'CycleRiderSignalService',
      );
      return null;
    }
  }

  /**
   * Apply common filters
   */
  private async applyCommonFilters(
    symbol: string,
    candles: any[],
    currentPrice: number,
  ): Promise<{ passed: boolean; reason?: string }> {
    // 1. ATR check (volatility)
    const atr = Indicators.calculateAtr(candles, 14);
    const atrPercent = atr / currentPrice;

    if (atrPercent < this.config.filters.minAtrPercent) {
      this.logger.debug(
        `[CycleRider-Filter] ${symbol} ❌ ATR too low: ${(atrPercent * 100).toFixed(3)}% < ${(this.config.filters.minAtrPercent * 100).toFixed(3)}%`,
        'CycleRiderSignalService',
      );
      return { passed: false, reason: 'ATR too low (not enough volatility)' };
    }

    if (atrPercent > this.config.filters.maxAtrPercent) {
      this.logger.debug(
        `[CycleRider-Filter] ${symbol} ❌ ATR too high: ${(atrPercent * 100).toFixed(3)}% > ${(this.config.filters.maxAtrPercent * 100).toFixed(3)}%`,
        'CycleRiderSignalService',
      );
      return { passed: false, reason: 'ATR too high (too much volatility)' };
    }

    this.logger.debug(
      `[CycleRider-Filter] ${symbol} ✅ ATR OK: ${(atrPercent * 100).toFixed(3)}% (range: ${(this.config.filters.minAtrPercent * 100).toFixed(3)}%-${(this.config.filters.maxAtrPercent * 100).toFixed(3)}%)`,
      'CycleRiderSignalService',
    );

    // 2. Funding rate check
    const fundingRate = await this.cacheService.getFundingRate(symbol);
    if (fundingRate !== null && Math.abs(fundingRate) > this.config.filters.maxAbsFundingRate) {
      return { passed: false, reason: 'Funding rate extreme' };
    }

    // 3. Volume check (basic)
    const recentVolumes = candles.slice(-10).map((c) => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    if (avgVolume === 0) {
      return { passed: false, reason: 'No volume' };
    }

    return { passed: true };
  }

  /**
   * Check consecutive bars filter (CRITICAL!)
   * Prevents late entry into trends
   */
  private checkConsecutiveBars(
    candles: any[],
    direction: string,
  ): { passed: boolean; reason?: string } {
    const consecutiveBars = CandleAnalyzer.countConsecutiveBars(
      candles,
      direction === 'LONG' ? 'UP' : 'DOWN',
    );

    if (consecutiveBars > this.config.filters.maxConsecutiveBars) {
      return {
        passed: false,
        reason: `Too many consecutive ${direction} bars (${consecutiveBars} > ${this.config.filters.maxConsecutiveBars})`,
      };
    }

    return { passed: true };
  }
}
