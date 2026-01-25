import { Injectable } from '@nestjs/common';
import { MtfAlignmentAnalyzerService } from './mtf-alignment-analyzer.service';
import { RelativeStrengthRankerService } from './relative-strength-ranker.service';
import { FundingExtremesDetectorService } from './funding-extremes-detector.service';
import { DataCacheService } from '../data/data-cache.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Candle } from '../../interfaces/candle.interface';
import { MarketRegime } from '../../../entities/market-regime-history.entity';
import { TradeDirection } from '../../../entities/trade.entity';
import { HOUR_SWING_CONFIG } from '../../constants/hour-swing.config';
import { Indicators } from '../../utils/indicators';

/**
 * Hour Swing Signal Service
 * Integrates all Hour Swing sub-strategies
 *
 * 2026-01-24 개선:
 * - SIDEWAYS 레짐: Hour Swing 완전 OFF
 * - Loss-streak Kill Switch: 3연패 → 60분 쿨다운
 */
@Injectable()
export class HourSwingSignalService {
  // Loss-streak tracking (전략 레벨 쿨다운)
  private consecutiveLosses = 0;
  private cooldownUntil = 0; // timestamp

  constructor(
    private readonly mtfAlignment: MtfAlignmentAnalyzerService,
    private readonly relativeStrength: RelativeStrengthRankerService,
    private readonly fundingExtremes: FundingExtremesDetectorService,
    private readonly cacheService: DataCacheService,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Record trade result for loss-streak tracking
   * Called by executor after trade closes
   */
  recordTradeResult(isLoss: boolean): void {
    const killSwitch = (HOUR_SWING_CONFIG as any).lossStreakKillSwitch;
    if (!killSwitch?.enabled) return;

    if (isLoss) {
      this.consecutiveLosses++;
      this.logger.warn(
        `[HourSwing] 🔴 Loss recorded. Consecutive losses: ${this.consecutiveLosses}/${killSwitch.maxConsecutiveLosses}`,
        'HourSwingSignalService',
      );

      if (this.consecutiveLosses >= killSwitch.maxConsecutiveLosses) {
        this.cooldownUntil = Date.now() + killSwitch.cooldownMinutes * 60 * 1000;
        this.logger.warn(
          `[HourSwing] ⛔ KILL SWITCH ACTIVATED! ${this.consecutiveLosses} consecutive losses. ` +
            `Cooldown until ${new Date(this.cooldownUntil).toISOString()} (${killSwitch.cooldownMinutes} min)`,
          'HourSwingSignalService',
        );
      }
    } else {
      // Win resets streak
      if (this.consecutiveLosses > 0) {
        this.logger.log(
          `[HourSwing] 🟢 Win recorded. Consecutive losses reset (was: ${this.consecutiveLosses})`,
          'HourSwingSignalService',
        );
      }
      this.consecutiveLosses = 0;
    }
  }

  /**
   * Check if strategy is in cooldown from kill switch
   */
  isInCooldown(): boolean {
    const killSwitch = (HOUR_SWING_CONFIG as any).lossStreakKillSwitch;
    if (!killSwitch?.enabled) return false;

    const now = Date.now();
    if (now < this.cooldownUntil) {
      const remainingMin = Math.ceil((this.cooldownUntil - now) / 60000);
      return true;
    }

    // Cooldown expired, reset
    if (this.cooldownUntil > 0 && now >= this.cooldownUntil) {
      this.logger.log(
        `[HourSwing] ✅ Kill switch cooldown expired. Resetting consecutive losses.`,
        'HourSwingSignalService',
      );
      this.consecutiveLosses = 0;
      this.cooldownUntil = 0;
    }

    return false;
  }

  /**
   * Get cooldown status for monitoring
   */
  getCooldownStatus(): { isActive: boolean; remainingMinutes: number; consecutiveLosses: number } {
    const now = Date.now();
    const isActive = now < this.cooldownUntil;
    const remainingMinutes = isActive ? Math.ceil((this.cooldownUntil - now) / 60000) : 0;
    return {
      isActive,
      remainingMinutes,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  /**
   * Initialize funding rate history for all symbols
   * This should be called once when the trading system starts
   */
  async initializeFundingHistory(symbols: string[]): Promise<void> {
    await this.fundingExtremes.initializeFundingHistory(symbols);
  }

  /**
   * Generate signal for a symbol
   */
  async generateSignal(symbol: string, regime: MarketRegime): Promise<TradingSignal | null> {
    try {
      this.logger.debug(
        `[HourSwing] ${symbol} Starting analysis (regime=${regime})`,
        'HourSwingSignalService',
      );

      // ========== 2026-01-24: SIDEWAYS 레짐 완전 OFF ==========
      const regimeFilter = (HOUR_SWING_CONFIG as any).regimeFilter;
      if (regimeFilter?.sidewaysOff && regime === MarketRegime.SIDEWAYS) {
        this.logger.debug(
          `[HourSwing] ${symbol} ⛔ SIDEWAYS regime - Hour Swing completely OFF`,
          'HourSwingSignalService',
        );
        return null;
      }

      // ========== 2026-01-24: Loss-streak Kill Switch ==========
      if (this.isInCooldown()) {
        const status = this.getCooldownStatus();
        this.logger.debug(
          `[HourSwing] ${symbol} ⛔ Kill switch active - ${status.remainingMinutes} min remaining (${status.consecutiveLosses} consecutive losses)`,
          'HourSwingSignalService',
        );
        return null;
      }

      // Get current price and funding
      const currentPrice = await this.cacheService.getCurrentPrice(symbol);
      if (!currentPrice) {
        this.logger.debug(
          `[HourSwing] ${symbol} No current price available`,
          'HourSwingSignalService',
        );
        return null;
      }

      const fundingRate = await this.cacheService.getFundingRate(symbol) || 0;

      this.logger.debug(
        `[HourSwing] ${symbol} Price=${currentPrice.toFixed(2)}, Funding=${(fundingRate * 100).toFixed(4)}%`,
        'HourSwingSignalService',
      );

      // ========== NEW: ATR Filter ==========
      const filters = (HOUR_SWING_CONFIG as any).filters;
      if (filters) {
        const candles1h = await this.cacheService.getRecentCandles(symbol, '1h', 20);
        if (candles1h && candles1h.length >= filters.atrPeriod) {
          const atr = Indicators.calculateAtr(candles1h, filters.atrPeriod);
          const atrPercent = atr / currentPrice;

          if (atrPercent > filters.maxAtrPercent) {
            this.logger.debug(
              `[HourSwing] ${symbol} ❌ ATR too high: ${(atrPercent * 100).toFixed(2)}% > ${(filters.maxAtrPercent * 100).toFixed(2)}%`,
              'HourSwingSignalService',
            );
            return null;
          }

          if (atrPercent < filters.minAtrPercent) {
            this.logger.debug(
              `[HourSwing] ${symbol} ❌ ATR too low: ${(atrPercent * 100).toFixed(2)}% < ${(filters.minAtrPercent * 100).toFixed(2)}%`,
              'HourSwingSignalService',
            );
            return null;
          }

          this.logger.debug(
            `[HourSwing] ${symbol} ✅ ATR check passed: ${(atrPercent * 100).toFixed(2)}%`,
            'HourSwingSignalService',
          );
        }
      }

      // Get BTC candles (needed for RS strategy)
      const btcCandles = await this.cacheService.getRecentCandles('BTCUSDT', '1h', 24);

      // Try each sub-strategy in priority order
      const strategies = [
        {
          name: 'mtf_alignment',
          detect: async () => await this.mtfAlignment.analyze(symbol, currentPrice, fundingRate),
        },
        {
          name: 'relative_strength',
          detect: async () => {
            if (!btcCandles || btcCandles.length < 24) return { detected: false } as any;
            return await this.relativeStrength.analyze(symbol, currentPrice, btcCandles);
          },
        },
        {
          name: 'funding_extremes',
          detect: async () => {
            const candles = await this.cacheService.getRecentCandles(symbol, '1h', 24);
            if (!candles || candles.length < 10) return { detected: false } as any;
            return await this.fundingExtremes.detect(symbol, candles, currentPrice, fundingRate);
          },
        },
      ];

      for (const strategy of strategies) {
        this.logger.debug(
          `[HourSwing] ${symbol} Checking sub-strategy: ${strategy.name}`,
          'HourSwingSignalService',
        );

        const signal = await strategy.detect();

        if (signal.detected) {
          // ========== IMPROVED: Regime Filter (WEAK 포함) ==========
          const regimeFilter = (HOUR_SWING_CONFIG as any).regimeFilter;
          if (regimeFilter?.enabled && regimeFilter?.blockCounterTrend) {
            // Block LONG during STRONG_DOWNTREND
            if (signal.direction === TradeDirection.LONG && regime === MarketRegime.STRONG_DOWNTREND) {
              this.logger.warn(
                `[HourSwing] ${symbol} ❌ REGIME FILTER: LONG blocked during STRONG_DOWNTREND (${signal.subStrategy})`,
                'HourSwingSignalService',
              );
              continue; // Try next sub-strategy
            }

            // Block SHORT during STRONG_UPTREND
            if (signal.direction === TradeDirection.SHORT && regime === MarketRegime.STRONG_UPTREND) {
              this.logger.warn(
                `[HourSwing] ${symbol} ❌ REGIME FILTER: SHORT blocked during STRONG_UPTREND (${signal.subStrategy})`,
                'HourSwingSignalService',
              );
              continue; // Try next sub-strategy
            }

            // NEW: Block counter-trend in WEAK regimes too
            if (regimeFilter?.blockWeakCounterTrend) {
              // Block LONG during WEAK_DOWNTREND
              if (signal.direction === TradeDirection.LONG && regime === MarketRegime.WEAK_DOWNTREND) {
                this.logger.warn(
                  `[HourSwing] ${symbol} ❌ REGIME FILTER: LONG blocked during WEAK_DOWNTREND (${signal.subStrategy})`,
                  'HourSwingSignalService',
                );
                continue;
              }

              // Block SHORT during WEAK_UPTREND
              if (signal.direction === TradeDirection.SHORT && regime === MarketRegime.WEAK_UPTREND) {
                this.logger.warn(
                  `[HourSwing] ${symbol} ❌ REGIME FILTER: SHORT blocked during WEAK_UPTREND (${signal.subStrategy})`,
                  'HourSwingSignalService',
                );
                continue;
              }
            }

            this.logger.debug(
              `[HourSwing] ${symbol} ✅ Regime filter passed: ${signal.direction} allowed in ${regime}`,
              'HourSwingSignalService',
            );
          }

          // Add market regime to signal
          signal.marketRegime = regime;

          this.logger.log(
            `[HourSwing] ${symbol} ✅ Signal generated by ${signal.subStrategy}! Direction=${signal.direction}`,
            'HourSwingSignalService',
          );

          return signal;
        } else {
          this.logger.debug(
            `[HourSwing] ${symbol} No signal from ${strategy.name}`,
            'HourSwingSignalService',
          );
        }
      }

      this.logger.debug(
        `[HourSwing] ${symbol} No signals from any sub-strategy`,
        'HourSwingSignalService',
      );

      return null;
    } catch (error) {
      this.logger.error(
        `Error generating signal for ${symbol}: ${error.message}`,
        error.stack,
        'HourSwingSignalService',
      );
      return null;
    }
  }

  /**
   * Pass-through methods for 1m candle entry checking
   */

  hasActiveExtreme(symbol: string): boolean {
    return this.fundingExtremes.hasActiveExtreme(symbol);
  }

  async checkFundingExtremesReversalZone(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
  ): Promise<any> {
    return this.fundingExtremes.checkReversalZoneOnly(symbol, candles, currentPrice);
  }

  /**
   * Detect funding extremes only (for 15m candle close)
   * This registers active extremes for 1m entry checking without running full HourSwing analysis
   */
  async detectFundingExtremesOnly(symbol: string): Promise<TradingSignal | null> {
    try {
      const currentPrice = await this.cacheService.getCurrentPrice(symbol);
      if (!currentPrice) return null;

      const fundingRate = await this.cacheService.getFundingRate(symbol) || 0;
      const candles = await this.cacheService.getRecentCandles(symbol, '1h', 24);
      if (!candles || candles.length < 10) return null;

      // This will register active extreme if detected (even if full signal isn't generated)
      const signal = await this.fundingExtremes.detect(symbol, candles, currentPrice, fundingRate);

      if (signal.detected) {
        this.logger.log(
          `[FundingExtremes-15m] ${symbol} ✅ Extreme detected and registered for 1M-Entry`,
          'HourSwingSignalService',
        );
      }

      return signal.detected ? signal : null;
    } catch (error) {
      this.logger.error(
        `Error detecting funding extremes for ${symbol}: ${error.message}`,
        error.stack,
        'HourSwingSignalService',
      );
      return null;
    }
  }
}
