import { Injectable } from '@nestjs/common';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Squeeze Detector (Bollinger Bands / Keltner Channel)
 * Detects consolidation followed by breakout
 */
@Injectable()
export class SqueezeDetectorService {
  private readonly config = CYCLE_RIDER_CONFIG.subStrategies.squeeze;

  constructor(private readonly logger: CustomLoggerService) {}

  async detect(candles: Candle[], currentPrice: number): Promise<TradingSignal> {
    const symbol = candles[0]?.symbol || 'UNKNOWN';

    if (!this.config.enabled || candles.length < Math.max(this.config.bbPeriod, this.config.kcPeriod) + 10) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[Squeeze] ${symbol} Starting analysis (${candles.length} candles)`,
      'SqueezeDetector',
    );

    const atr = Indicators.calculateAtr(candles, 14);

    // 1. Check for squeeze release
    const squeezeData = Indicators.detectSqueeze(
      candles,
      this.config.bbPeriod,
      this.config.bbStdDev,
      this.config.kcPeriod,
      this.config.kcAtrMultiple,
    );

    this.logger.debug(
      `[Squeeze] ${symbol} Current squeeze status: inSqueeze=${squeezeData.inSqueeze}, bars=${squeezeData.bars || 0}`,
      'SqueezeDetector',
    );

    // We want squeeze to have lasted minimum bars, then released
    if (squeezeData.inSqueeze) {
      // Still in squeeze, wait for release
      return { detected: false } as any;
    }

    // Check if squeeze was recently active (just released)
    const prevCandles = candles.slice(0, -1);
    const prevSqueezeData = Indicators.detectSqueeze(
      prevCandles,
      this.config.bbPeriod,
      this.config.bbStdDev,
      this.config.kcPeriod,
      this.config.kcAtrMultiple,
    );

    this.logger.debug(
      `[Squeeze] ${symbol} Previous squeeze status: inSqueeze=${prevSqueezeData.inSqueeze}, ` +
        `bars=${prevSqueezeData.bars || 0} (min=${this.config.minSqueezeBars})`,
      'SqueezeDetector',
    );

    if (!prevSqueezeData.inSqueeze || prevSqueezeData.bars < this.config.minSqueezeBars) {
      return { detected: false } as any;
    }

    this.logger.log(
      `[Squeeze] ${symbol} 💥 Squeeze released! Duration was ${prevSqueezeData.bars} bars`,
      'SqueezeDetector',
    );

    // 2. Check RVol (Relative Volume) - require strong volume on breakout
    const rvolData = Indicators.calculateRVol(candles, 20);

    this.logger.debug(
      `[Squeeze] ${symbol} RVol check: ${rvolData.rvol.toFixed(2)} (min=1.5)`,
      'SqueezeDetector',
    );

    if (rvolData.rvol < 1.5) {
      // Volume too low for squeeze breakout, skip
      return { detected: false } as any;
    }

    // 3. Check ADX (trend strength) - require moderate to strong trend
    const adxData = Indicators.calculateAdx(candles, 14);

    this.logger.debug(
      `[Squeeze] ${symbol} ADX check: ${adxData.adx.toFixed(2)} (min=20)`,
      'SqueezeDetector',
    );

    if (adxData.adx < 20) {
      // Trend too weak for squeeze breakout, skip
      return { detected: false } as any;
    }

    // 4. Determine breakout direction using momentum
    const momentum = this.calculateMomentum(candles, this.config.momentumPeriod);

    this.logger.debug(
      `[Squeeze] ${symbol} Momentum: ${momentum.toFixed(2)}% (min strength=${this.config.minMomentumStrength})`,
      'SqueezeDetector',
    );

    if (Math.abs(momentum) < this.config.minMomentumStrength) {
      return { detected: false } as any;
    }

    const direction = momentum > 0 ? TradeDirection.LONG : TradeDirection.SHORT;

    // 3. Calculate TP/SL
    // Squeeze breakouts can be explosive, use wider targets
    if (direction === TradeDirection.LONG) {
      const slPrice = currentPrice - atr * this.config.tpSl.slAtrMultiple;
      const tp1Price = currentPrice + atr * this.config.tpSl.tp1AtrMultiple;
      const tp2Price = currentPrice + atr * this.config.tpSl.tp2AtrMultiple;

      this.logger.log(
        `[Squeeze] ${symbol} ✅ LONG breakout signal! ` +
          `Entry=${currentPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}, ` +
          `TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
          `Momentum=${momentum.toFixed(2)}%, SqueezeBars=${prevSqueezeData.bars}`,
        'SqueezeDetector',
      );

      return {
        detected: true,
        strategyType: StrategyType.CYCLE_RIDER,
        subStrategy: 'squeeze',
        symbol: candles[0].symbol,
        direction,
        entryPrice: currentPrice,
        slPrice,
        tp1Price,
        tp2Price,
        useTrailing: this.config.tpSl.useTrailing,
        confidence: 70,
        metadata: {
          atr,
          squeezeBars: prevSqueezeData.bars,
          momentum,
          rvol: rvolData.rvol,
          adx: adxData.adx,
        },
      };
    } else {
      const slPrice = currentPrice + atr * this.config.tpSl.slAtrMultiple;
      const tp1Price = currentPrice - atr * this.config.tpSl.tp1AtrMultiple;
      const tp2Price = currentPrice - atr * this.config.tpSl.tp2AtrMultiple;

      this.logger.log(
        `[Squeeze] ${symbol} ✅ SHORT breakout signal! ` +
          `Entry=${currentPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}, ` +
          `TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
          `Momentum=${momentum.toFixed(2)}%, SqueezeBars=${prevSqueezeData.bars}`,
        'SqueezeDetector',
      );

      return {
        detected: true,
        strategyType: StrategyType.CYCLE_RIDER,
        subStrategy: 'squeeze',
        symbol: candles[0].symbol,
        direction,
        entryPrice: currentPrice,
        slPrice,
        tp1Price,
        tp2Price,
        useTrailing: this.config.tpSl.useTrailing,
        confidence: 70,
        metadata: {
          atr,
          squeezeBars: prevSqueezeData.bars,
          momentum,
          rvol: rvolData.rvol,
          adx: adxData.adx,
        },
      };
    }
  }

  /**
   * Calculate momentum indicator
   * Simple momentum: (Close - Close[n]) / Close[n]
   */
  private calculateMomentum(candles: Candle[], period: number): number {
    if (candles.length < period + 1) {
      return 0;
    }

    const currentClose = candles[candles.length - 1].close;
    const pastClose = candles[candles.length - 1 - period].close;

    return ((currentClose - pastClose) / pastClose) * 100;
  }
}
