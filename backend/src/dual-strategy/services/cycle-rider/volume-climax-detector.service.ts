import { Injectable } from '@nestjs/common';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Volume Climax Detector
 * Detects exhaustion through extreme volume and price movement
 * Trade in OPPOSITE direction of climax
 */
@Injectable()
export class VolumeClimaxDetectorService {
  private readonly config = CYCLE_RIDER_CONFIG.subStrategies.volumeClimax;

  constructor(private readonly logger: CustomLoggerService) {}

  async detect(candles: Candle[], currentPrice: number): Promise<TradingSignal> {
    const symbol = candles[0]?.symbol || 'UNKNOWN';

    if (!this.config.enabled || candles.length < this.config.volumeAvgPeriod + 10) {
      return { detected: false } as any;
    }

    // Need to wait entryDelay bars after climax
    if (candles.length < this.config.entryDelay + 1) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[VolumeClimax] ${symbol} Starting analysis (${candles.length} candles)`,
      'VolumeClimaxDetector',
    );

    const atr = Indicators.calculateAtr(candles, 14);
    const rsi = Indicators.calculateRsi(candles, this.config.rsiPeriod);

    // Check for climax 1-2 bars ago
    for (let i = 1; i <= this.config.entryDelay + 1; i++) {
      const climaxIdx = candles.length - 1 - i;
      if (climaxIdx < this.config.volumeAvgPeriod) continue;

      const climax = this.detectClimax(candles, climaxIdx, atr, rsi, symbol);
      if (climax.detected) {
        this.logger.debug(
          `[VolumeClimax] ${symbol} Climax detected ${i} bars ago! Type=${climax.type}`,
          'VolumeClimaxDetector',
        );

        // Check if trend has started to exhaust
        if (this.config.requireTrendExhaustion) {
          const trendExhausted = this.checkTrendExhaustion(candles, climax.type, symbol);
          if (!trendExhausted) {
            this.logger.debug(
              `[VolumeClimax] ${symbol} Trend not exhausted, skipping`,
              'VolumeClimaxDetector',
            );
            continue;
          }
        }

        // Check if RSI is still extreme at current bar (prevent late entry after recovery)
        if (this.config.requireRsiStillExtreme) {
          const currentRsi = rsi;
          if (climax.type === 'SELLING') {
            // For LONG entry, RSI must still be low
            if (currentRsi > this.config.rsiReentryLong) {
              this.logger.debug(
                `[VolumeClimax] ${symbol} RSI recovered too much: ${currentRsi.toFixed(2)} > ${this.config.rsiReentryLong}, skipping`,
                'VolumeClimaxDetector',
              );
              continue;
            }
          } else {
            // For SHORT entry, RSI must still be high
            if (currentRsi < this.config.rsiReentryShort) {
              this.logger.debug(
                `[VolumeClimax] ${symbol} RSI recovered too much: ${currentRsi.toFixed(2)} < ${this.config.rsiReentryShort}, skipping`,
                'VolumeClimaxDetector',
              );
              continue;
            }
          }
          this.logger.debug(
            `[VolumeClimax] ${symbol} ✅ RSI still extreme: ${currentRsi.toFixed(2)} (type=${climax.type})`,
            'VolumeClimaxDetector',
          );
        }

        // Calculate TP/SL based on R:R (Risk:Reward ratio)
        const climaxCandle = candles[climaxIdx];
        const slDistance = atr * this.config.tpSl.slAtrMultiple;

        if (climax.type === 'BUYING') {
          // Buying climax detected -> Go SHORT (fade the climax)
          const slPrice = currentPrice + slDistance;
          const tp1Price = currentPrice - slDistance * this.config.tpSl.tp1RR; // 1.5 R:R
          const tp2Price = currentPrice - slDistance * this.config.tpSl.tp2RR; // 2.5 R:R

          this.logger.log(
            `[VolumeClimax] ${symbol} ✅ BUYING climax -> SHORT signal! ` +
              `Entry=${currentPrice.toFixed(4)}, SL=${slPrice.toFixed(4)}, ` +
              `TP1=${tp1Price.toFixed(4)} (${this.config.tpSl.tp1RR}R), TP2=${tp2Price.toFixed(4)} (${this.config.tpSl.tp2RR}R), ` +
              `ClimaxVol=${climaxCandle.volume.toFixed(0)}, BarsAgo=${i}`,
            'VolumeClimaxDetector',
          );

          return {
            detected: true,
            strategyType: StrategyType.CYCLE_RIDER,
            subStrategy: 'volume_climax',
            symbol: candles[0].symbol,
            direction: TradeDirection.SHORT,
            entryPrice: currentPrice,
            slPrice,
            tp1Price,
            tp2Price,
            useTrailing: this.config.tpSl.useTrailing,
            confidence: 75,
            metadata: {
              atr,
              rsi,
              climaxType: climax.type,
              climaxVolume: climaxCandle.volume,
              climaxBar: i,
            },
          };
        } else {
          // Selling climax detected -> Go LONG (fade the climax)
          const slPrice = currentPrice - slDistance;
          const tp1Price = currentPrice + slDistance * this.config.tpSl.tp1RR; // 1.5 R:R
          const tp2Price = currentPrice + slDistance * this.config.tpSl.tp2RR; // 2.5 R:R

          this.logger.log(
            `[VolumeClimax] ${symbol} ✅ SELLING climax -> LONG signal! ` +
              `Entry=${currentPrice.toFixed(4)}, SL=${slPrice.toFixed(4)}, ` +
              `TP1=${tp1Price.toFixed(4)} (${this.config.tpSl.tp1RR}R), TP2=${tp2Price.toFixed(4)} (${this.config.tpSl.tp2RR}R), ` +
              `ClimaxVol=${climaxCandle.volume.toFixed(0)}, BarsAgo=${i}`,
            'VolumeClimaxDetector',
          );

          return {
            detected: true,
            strategyType: StrategyType.CYCLE_RIDER,
            subStrategy: 'volume_climax',
            symbol: candles[0].symbol,
            direction: TradeDirection.LONG,
            entryPrice: currentPrice,
            slPrice,
            tp1Price,
            tp2Price,
            useTrailing: this.config.tpSl.useTrailing,
            confidence: 75,
            metadata: {
              atr,
              rsi,
              climaxType: climax.type,
              climaxVolume: climaxCandle.volume,
              climaxBar: i,
            },
          };
        }
      }
    }

    return { detected: false } as any;
  }

  /**
   * Detect volume climax at specific index
   */
  private detectClimax(
    candles: Candle[],
    idx: number,
    atr: number,
    rsi: number,
    symbol: string,
  ): { detected: boolean; type: 'BUYING' | 'SELLING' | null } {
    const candle = candles[idx];

    // 1. Volume spike (3x average)
    const volumeCandles = candles.slice(
      Math.max(0, idx - this.config.volumeAvgPeriod),
      idx,
    );
    const avgVolume = volumeCandles.reduce((sum, c) => sum + c.volume, 0) / volumeCandles.length;
    const volumeMultiple = candle.volume / avgVolume;

    this.logger.debug(
      `[VolumeClimax] ${symbol} Volume check at bar ${idx}: ` +
        `vol=${candle.volume.toFixed(0)}, avg=${avgVolume.toFixed(0)}, ` +
        `multiple=${volumeMultiple.toFixed(2)}x (min=${this.config.minVolumeMultiple}x)`,
      'VolumeClimaxDetector',
    );

    if (candle.volume < avgVolume * this.config.minVolumeMultiple) {
      return { detected: false, type: null };
    }

    // 2. Large candle (2x ATR)
    const candleSize = Math.abs(candle.close - candle.open);
    const candleSizeAtr = candleSize / atr;

    this.logger.debug(
      `[VolumeClimax] ${symbol} Candle size check: ` +
        `size=${candleSize.toFixed(2)}, ATR=${atr.toFixed(2)}, ` +
        `sizeAtr=${candleSizeAtr.toFixed(2)} (min=${this.config.minCandleSizeAtr})`,
      'VolumeClimaxDetector',
    );

    if (candleSize < atr * this.config.minCandleSizeAtr) {
      return { detected: false, type: null };
    }

    // 3. Check type based on RSI
    const candleRsi = Indicators.calculateRsi(candles.slice(0, idx + 1), this.config.rsiPeriod);

    // Buying climax (exhaustion of uptrend)
    if (candle.close > candle.open && candleRsi >= this.config.rsiBuyingClimax) {
      this.logger.debug(
        `[VolumeClimax] ${symbol} BUYING climax: bullish candle with RSI=${candleRsi.toFixed(2)} >= ${this.config.rsiBuyingClimax}`,
        'VolumeClimaxDetector',
      );
      return { detected: true, type: 'BUYING' };
    }

    // Selling climax (exhaustion of downtrend)
    if (candle.close < candle.open && candleRsi <= this.config.rsiSellingClimax) {
      this.logger.debug(
        `[VolumeClimax] ${symbol} SELLING climax: bearish candle with RSI=${candleRsi.toFixed(2)} <= ${this.config.rsiSellingClimax}`,
        'VolumeClimaxDetector',
      );
      return { detected: true, type: 'SELLING' };
    }

    return { detected: false, type: null };
  }

  /**
   * Check if trend is showing exhaustion
   */
  private checkTrendExhaustion(
    candles: Candle[],
    climaxType: 'BUYING' | 'SELLING',
    symbol: string,
  ): boolean {
    if (candles.length < this.config.minTrendBars) {
      return false;
    }

    const trendCandles = candles.slice(-this.config.minTrendBars);
    const trend = CandleAnalyzer.calculateTrendStrength(trendCandles);

    this.logger.debug(
      `[VolumeClimax] ${symbol} Trend exhaustion check: ` +
        `climaxType=${climaxType}, trendDirection=${trend.direction}, strength=${trend.strength.toFixed(2)}`,
      'VolumeClimaxDetector',
    );

    if (climaxType === 'BUYING') {
      // For buying climax, we want to see uptrend before exhaustion
      return trend.direction === 'UP' && trend.strength >= 0.4;
    } else {
      // For selling climax, we want to see downtrend before exhaustion
      return trend.direction === 'DOWN' && trend.strength >= 0.4;
    }
  }
}
