import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DataCacheService } from '../data/data-cache.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { MarketRegimeHistory, MarketRegime } from '../../../entities/market-regime-history.entity';
import { SystemEventType } from '../../../entities/system-log.entity';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { Indicators } from '../../utils/indicators';

const REGIME_CONFIG = {
  btc: {
    symbol: 'BTCUSDT',
    timeframe: '1h' as const,
    trendPeriod: 24,
  },
  thresholds: {
    strongTrendStrength: 0.6,
    weakTrendStrength: 0.3,
  },
  // Strategy weights based on regime
  strategyWeights: {
    STRONG_UPTREND: { cycleRider: 0.7, hourSwing: 0.3 },
    WEAK_UPTREND: { cycleRider: 0.4, hourSwing: 0.6 },
    SIDEWAYS: { cycleRider: 0.3, hourSwing: 0.7 },
    WEAK_DOWNTREND: { cycleRider: 0.4, hourSwing: 0.6 },
    STRONG_DOWNTREND: { cycleRider: 0.7, hourSwing: 0.3 },
  },
  // BTC Veto (거부권) - Flash Crash Protection
  flashCrash: {
    enabled: true,
    dropThreshold: -1.0, // -1% drop triggers veto
    timeframes: ['5m', '15m'] as const,
    lookbackPeriods: { '5m': 3, '15m': 1 }, // Check last 3x5m or 1x15m candles
    vetoLongsDuration: 60, // Block longs for 60 minutes after flash crash
  },
  // Volatility Filter (ATR-based)
  volatility: {
    enabled: true,
    minAtrPercent: 0.5, // Minimum 0.5% ATR to avoid "dead markets"
    maxAtrPercent: 8.0, // Maximum 8% ATR to avoid extreme volatility
  },
  // BTC Dominance Check
  dominance: {
    enabled: true,
    surgingThreshold: 1.0, // 1% increase in dominance = surging
    lookbackHours: 24, // Check 24-hour dominance change
    reduceAltcoinLongs: true, // Reduce altcoin longs when BTC dominance surges
  },
};

/**
 * Market Regime Classifier
 * Classifies market regime based on BTC 1H trend
 */
@Injectable()
export class MarketRegimeClassifierService {
  private currentRegime: MarketRegime = MarketRegime.SIDEWAYS;
  private flashCrashDetectedAt: Date | null = null;
  private lastBtcDominance: number | null = null;
  private lastDominanceCheckTime: Date | null = null;

  constructor(
    @InjectRepository(MarketRegimeHistory)
    private readonly regimeRepo: Repository<MarketRegimeHistory>,
    private readonly cacheService: DataCacheService,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Classify current market regime
   */
  async classifyRegime(): Promise<MarketRegime> {
    try {
      // Get BTC 1H candles
      const btcCandles = await this.cacheService.getRecentCandles(
        REGIME_CONFIG.btc.symbol,
        REGIME_CONFIG.btc.timeframe,
        REGIME_CONFIG.btc.trendPeriod,
      );

      if (!btcCandles || btcCandles.length < REGIME_CONFIG.btc.trendPeriod) {
        this.logger.warn('Insufficient BTC data for regime classification', 'MarketRegimeClassifier');
        return this.currentRegime;
      }

      // Calculate trend
      const trend = CandleAnalyzer.calculateTrendStrength(btcCandles);
      const btcPrice = btcCandles[btcCandles.length - 1].close;
      const atr = Indicators.calculateAtr(btcCandles, 14);
      const volatility = (atr / btcPrice) * 100;

      // Classify regime
      let regime: MarketRegime;

      if (trend.direction === 'UP') {
        if (trend.strength >= REGIME_CONFIG.thresholds.strongTrendStrength) {
          regime = MarketRegime.STRONG_UPTREND;
        } else if (trend.strength >= REGIME_CONFIG.thresholds.weakTrendStrength) {
          regime = MarketRegime.WEAK_UPTREND;
        } else {
          regime = MarketRegime.SIDEWAYS;
        }
      } else if (trend.direction === 'DOWN') {
        if (trend.strength >= REGIME_CONFIG.thresholds.strongTrendStrength) {
          regime = MarketRegime.STRONG_DOWNTREND;
        } else if (trend.strength >= REGIME_CONFIG.thresholds.weakTrendStrength) {
          regime = MarketRegime.WEAK_DOWNTREND;
        } else {
          regime = MarketRegime.SIDEWAYS;
        }
      } else {
        regime = MarketRegime.SIDEWAYS;
      }

      // Check if regime changed
      if (regime !== this.currentRegime) {
        this.logger.log(`Market regime changed: ${this.currentRegime} -> ${regime}`, 'MarketRegimeClassifier');

        await this.logger.logSystem({
          level: 'info',
          eventType: SystemEventType.MARKET_REGIME_UPDATE,
          message: `Market regime changed to ${regime}`,
          component: 'MarketRegimeClassifier',
          metadata: {
            previousRegime: this.currentRegime,
            newRegime: regime,
            trendStrength: trend.strength,
            btcPrice,
          },
        });

        this.currentRegime = regime;
      }

      // Save to database
      const weights = REGIME_CONFIG.strategyWeights[regime];
      await this.regimeRepo.save({
        regime,
        trend_strength: trend.strength,
        btc_price: btcPrice,
        btc_volatility: volatility,
        cycle_rider_weight: weights.cycleRider,
        hour_swing_weight: weights.hourSwing,
        metadata: {
          direction: trend.direction,
          atr,
        },
      });

      return regime;
    } catch (error) {
      this.logger.error(
        `Error classifying market regime: ${error.message}`,
        error.stack,
        'MarketRegimeClassifier',
      );
      return this.currentRegime;
    }
  }

  /**
   * Get current regime
   */
  getCurrentRegime(): MarketRegime {
    return this.currentRegime;
  }

  /**
   * Get strategy weights for current regime
   */
  getStrategyWeights(): { cycleRider: number; hourSwing: number } {
    return REGIME_CONFIG.strategyWeights[this.currentRegime];
  }

  /**
   * 🚨 BTC Veto: Flash Crash Protection
   * Checks if BTC dropped >1% in recent 5m or 15m candles
   * Blocks ALL long positions for 60 minutes after flash crash
   *
   * Example: BTC drops from $43,500 to $43,000 (-1.15%) in 15 minutes
   * → All long entries blocked for next 60 minutes
   */
  async isFlashCrashActive(): Promise<{ active: boolean; reason?: string }> {
    if (!REGIME_CONFIG.flashCrash.enabled) {
      return { active: false };
    }

    // Check if we're still in veto period from previous flash crash
    if (this.flashCrashDetectedAt) {
      const minutesSinceFlashCrash = (Date.now() - this.flashCrashDetectedAt.getTime()) / 1000 / 60;
      if (minutesSinceFlashCrash < REGIME_CONFIG.flashCrash.vetoLongsDuration) {
        return {
          active: true,
          reason: `Flash crash veto active (${Math.floor(REGIME_CONFIG.flashCrash.vetoLongsDuration - minutesSinceFlashCrash)}m remaining)`,
        };
      } else {
        // Veto expired
        this.flashCrashDetectedAt = null;
      }
    }

    try {
      // Check 5m and 15m timeframes for flash crashes
      for (const timeframe of REGIME_CONFIG.flashCrash.timeframes) {
        const lookback = REGIME_CONFIG.flashCrash.lookbackPeriods[timeframe];
        const candles = await this.cacheService.getRecentCandles(
          REGIME_CONFIG.btc.symbol,
          timeframe,
          lookback + 1, // +1 to calculate % change
        );

        if (!candles || candles.length < lookback + 1) continue;

        // Calculate price change over the period
        const startPrice = candles[0].close;
        const endPrice = candles[candles.length - 1].close;
        const priceChange = ((endPrice - startPrice) / startPrice) * 100;

        if (priceChange <= REGIME_CONFIG.flashCrash.dropThreshold) {
          // Flash crash detected!
          this.flashCrashDetectedAt = new Date();
          const crashDescription = `BTC flash crash: ${priceChange.toFixed(2)}% drop in ${timeframe} (${startPrice.toFixed(0)} → ${endPrice.toFixed(0)})`;

          this.logger.warn(`🚨 ${crashDescription}`, 'MarketRegimeClassifier');

          await this.logger.logSystem({
            level: 'warn',
            eventType: SystemEventType.MARKET_REGIME_UPDATE,
            message: crashDescription,
            component: 'MarketRegimeClassifier',
            metadata: {
              timeframe,
              startPrice,
              endPrice,
              priceChange,
              vetoLongsDuration: REGIME_CONFIG.flashCrash.vetoLongsDuration,
            },
          });

          return {
            active: true,
            reason: crashDescription,
          };
        }
      }

      return { active: false };
    } catch (error) {
      this.logger.error(
        `Error checking flash crash: ${error.message}`,
        error.stack,
        'MarketRegimeClassifier',
      );
      return { active: false };
    }
  }

  /**
   * 📊 Volatility Filter: Avoid "Dead Markets"
   * Checks if market volatility (ATR%) is within acceptable range
   * Too low = dead market, too high = extreme chaos
   */
  async isVolatilityAcceptable(symbol: string = REGIME_CONFIG.btc.symbol): Promise<{
    acceptable: boolean;
    reason?: string;
    atrPercent?: number;
  }> {
    if (!REGIME_CONFIG.volatility.enabled) {
      return { acceptable: true };
    }

    try {
      const candles = await this.cacheService.getRecentCandles(symbol, '1h', 24);

      if (!candles || candles.length < 14) {
        return { acceptable: true }; // Not enough data, allow
      }

      const currentPrice = candles[candles.length - 1].close;
      const atr = Indicators.calculateAtr(candles, 14);
      const atrPercent = (atr / currentPrice) * 100;

      if (atrPercent < REGIME_CONFIG.volatility.minAtrPercent) {
        return {
          acceptable: false,
          reason: `Dead market: ATR ${atrPercent.toFixed(2)}% < ${REGIME_CONFIG.volatility.minAtrPercent}%`,
          atrPercent,
        };
      }

      if (atrPercent > REGIME_CONFIG.volatility.maxAtrPercent) {
        return {
          acceptable: false,
          reason: `Extreme volatility: ATR ${atrPercent.toFixed(2)}% > ${REGIME_CONFIG.volatility.maxAtrPercent}%`,
          atrPercent,
        };
      }

      return { acceptable: true, atrPercent };
    } catch (error) {
      this.logger.error(
        `Error checking volatility: ${error.message}`,
        error.stack,
        'MarketRegimeClassifier',
      );
      return { acceptable: true }; // On error, allow
    }
  }

  /**
   * 👑 BTC Dominance Check
   * Checks if BTC dominance is surging (increasing significantly)
   * When BTC dominance surges, reduce altcoin longs
   *
   * Returns: { surging: boolean, shouldReduceAltcoinLongs: boolean }
   */
  async isBtcDominanceSurging(): Promise<{
    surging: boolean;
    shouldReduceAltcoinLongs: boolean;
    dominance?: number;
    dominanceChange?: number;
  }> {
    if (!REGIME_CONFIG.dominance.enabled) {
      return { surging: false, shouldReduceAltcoinLongs: false };
    }

    try {
      // Fetch BTC dominance from CoinGecko API (free, no auth needed)
      const response = await fetch('https://api.coingecko.com/api/v3/global');
      if (!response.ok) {
        throw new Error(`Failed to fetch BTC dominance: ${response.statusText}`);
      }

      const data = await response.json();
      const currentDominance = data.data.market_cap_percentage.btc;

      if (!currentDominance) {
        throw new Error('BTC dominance data not available');
      }

      // First check - no historical data yet
      if (!this.lastBtcDominance || !this.lastDominanceCheckTime) {
        this.lastBtcDominance = currentDominance;
        this.lastDominanceCheckTime = new Date();
        return { surging: false, shouldReduceAltcoinLongs: false, dominance: currentDominance };
      }

      // Check if enough time has passed for meaningful comparison
      const hoursSinceLastCheck =
        (Date.now() - this.lastDominanceCheckTime.getTime()) / 1000 / 60 / 60;

      if (hoursSinceLastCheck >= 1) {
        // At least 1 hour passed
        const dominanceChange = currentDominance - this.lastBtcDominance;
        const isSurging = dominanceChange >= REGIME_CONFIG.dominance.surgingThreshold;

        if (isSurging) {
          this.logger.warn(
            `👑 BTC dominance surging: ${this.lastBtcDominance.toFixed(2)}% → ${currentDominance.toFixed(2)}% (+${dominanceChange.toFixed(2)}%)`,
            'MarketRegimeClassifier',
          );

          await this.logger.logSystem({
            level: 'warn',
            eventType: SystemEventType.MARKET_REGIME_UPDATE,
            message: 'BTC dominance surging - reducing altcoin longs',
            component: 'MarketRegimeClassifier',
            metadata: {
              previousDominance: this.lastBtcDominance,
              currentDominance,
              dominanceChange,
            },
          });
        }

        // Update stored values
        this.lastBtcDominance = currentDominance;
        this.lastDominanceCheckTime = new Date();

        return {
          surging: isSurging,
          shouldReduceAltcoinLongs: isSurging && REGIME_CONFIG.dominance.reduceAltcoinLongs,
          dominance: currentDominance,
          dominanceChange,
        };
      }

      // Not enough time passed, return previous state
      return {
        surging: false,
        shouldReduceAltcoinLongs: false,
        dominance: currentDominance,
      };
    } catch (error) {
      this.logger.error(
        `Error checking BTC dominance: ${error.message}`,
        error.stack,
        'MarketRegimeClassifier',
      );
      return { surging: false, shouldReduceAltcoinLongs: false };
    }
  }
}
