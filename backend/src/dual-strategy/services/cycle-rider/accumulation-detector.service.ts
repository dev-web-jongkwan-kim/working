import { Injectable } from '@nestjs/common';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Accumulation Detector - Wyckoff Accumulation Pattern
 * Detects smart money accumulation phase and spring pattern
 */
@Injectable()
export class AccumulationDetectorService {
  private readonly config = CYCLE_RIDER_CONFIG.subStrategies.accumulation;

  constructor(private readonly logger: CustomLoggerService) {}

  async detect(candles: Candle[], currentPrice: number): Promise<TradingSignal> {
    const symbol = candles[0]?.symbol || 'UNKNOWN';

    if (!this.config.enabled || candles.length < this.config.boxPeriod + 10) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[Accumulation] ${symbol} Starting analysis (${candles.length} candles)`,
      'AccumulationDetector',
    );

    // 1. Box range formation check
    const boxCandles = candles.slice(-this.config.boxPeriod);
    const atr = Indicators.calculateAtr(candles, 14);
    const boxAnalysis = CandleAnalyzer.isInBoxRange(boxCandles, this.config.boxRangeMaxAtr, atr);

    this.logger.debug(
      `[Accumulation] ${symbol} Box analysis: inBox=${boxAnalysis.inBox}, ` +
        `range=${boxAnalysis.boxRange?.toFixed(2) || 'N/A'}, ` +
        `maxAllowed=${(atr * this.config.boxRangeMaxAtr).toFixed(2)}, ` +
        `ATR=${atr.toFixed(2)}`,
      'AccumulationDetector',
    );

    if (!boxAnalysis.inBox) {
      return { detected: false } as any;
    }

    const { boxHigh, boxLow, boxRange } = boxAnalysis;

    // 2. Support test count
    const supportTests = CandleAnalyzer.countLevelTests(
      boxCandles,
      boxLow,
      this.config.supportTestThreshold,
      'support',
    );

    this.logger.debug(
      `[Accumulation] ${symbol} Support tests: ${supportTests}/${this.config.minSupportTests} ` +
        `(boxLow=${boxLow.toFixed(2)})`,
      'AccumulationDetector',
    );

    if (supportTests < this.config.minSupportTests) {
      return { detected: false } as any;
    }

    // 3. CVD rising trend (price sideways + CVD rising = accumulation)
    const cvdValues = Indicators.calculateCvd(candles.slice(-this.config.cvdPeriod - 5));
    const cvdTrend = Indicators.analyzeCvdTrend(cvdValues.slice(-this.config.cvdPeriod));
    const recentCvd = cvdValues.slice(-5).map((v) => v.toFixed(0));

    this.logger.debug(
      `[Accumulation] ${symbol} CVD trend: ${cvdTrend}, recent=[${recentCvd.join(', ')}]`,
      'AccumulationDetector',
    );

    if (cvdTrend !== 'RISING') {
      return { detected: false } as any;
    }

    // 4. Spring detection (key trigger!)
    const springData = this.detectSpring(candles, boxLow, atr, symbol);
    if (!springData.detected) {
      this.logger.debug(
        `[Accumulation] ${symbol} No spring pattern found`,
        'AccumulationDetector',
      );
      return { detected: false } as any;
    }

    this.logger.log(
      `[Accumulation] ${symbol} 💥 Spring detected! ` +
        `Low=${springData.springLow.toFixed(2)}, BoxLow=${boxLow.toFixed(2)}`,
      'AccumulationDetector',
    );

    // 5. Calculate confidence
    const confidence = Math.min(
      supportTests * 10 + // 10 points per support test
        30 + // Base confidence
        (cvdTrend === 'RISING' ? 30 : 0) + // CVD confirmation
        20, // Spring confirmation
      100,
    );

    this.logger.debug(
      `[Accumulation] ${symbol} Confidence: ${confidence}% (min=${this.config.minConfidence}%)`,
      'AccumulationDetector',
    );

    if (confidence < this.config.minConfidence) {
      return { detected: false } as any;
    }

    // 6. Calculate TP/SL
    const slPrice = springData.springLow - atr * this.config.tpSl.slAtrMultiple;
    const tp1Price = boxHigh;
    const tp2Price = boxHigh + boxRange;

    this.logger.log(
      `[Accumulation] ${symbol} ✅ Signal generated! ` +
        `Entry=${currentPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}, ` +
        `TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, Confidence=${confidence}%`,
      'AccumulationDetector',
    );

    return {
      detected: true,
      strategyType: StrategyType.CYCLE_RIDER,
      subStrategy: 'accumulation',
      symbol: candles[0].symbol,
      direction: TradeDirection.LONG,
      entryPrice: currentPrice,
      slPrice,
      tp1Price,
      tp2Price,
      useTrailing: this.config.tpSl.useTrailing,
      confidence,
      metadata: {
        atr,
        boxHigh,
        boxLow,
        boxRange,
        supportTests,
        cvdTrend,
        springLow: springData.springLow,
      },
    };
  }

  /**
   * Detect spring pattern
   * Spring = Brief break below support followed by quick recovery
   */
  private detectSpring(
    candles: Candle[],
    boxLow: number,
    atr: number,
    symbol: string,
  ): { detected: boolean; springLow: number } {
    const minBreak = boxLow * (1 - this.config.springBreakPercent);
    const maxBreak = boxLow * (1 - this.config.springMaxBreakPercent);

    this.logger.debug(
      `[Accumulation] ${symbol} Spring search: boxLow=${boxLow.toFixed(2)}, ` +
        `minBreak=${minBreak.toFixed(2)}, maxBreak=${maxBreak.toFixed(2)}`,
      'AccumulationDetector',
    );

    // Look back 10 bars for spring
    for (let i = candles.length - 4; i >= Math.max(0, candles.length - 10); i--) {
      const candle = candles[i];

      // Check if low broke below box but within acceptable range
      if (candle.low < minBreak && candle.low > maxBreak) {
        this.logger.debug(
          `[Accumulation] ${symbol} Potential spring at bar ${i}: ` +
            `low=${candle.low.toFixed(2)} (broke below ${boxLow.toFixed(2)})`,
          'AccumulationDetector',
        );

        // Check for recovery in next 3 bars
        let recovered = false;
        const recoveryBars = Math.min(i + this.config.springRecoveryBars, candles.length - 1);

        for (let j = i + 1; j <= recoveryBars; j++) {
          if (candles[j].close > boxLow) {
            // Check volume spike on recovery
            const avgVolume =
              candles
                .slice(Math.max(0, i - 10), i)
                .reduce((sum, c) => sum + c.volume, 0) / 10;
            const recoveryVolume = candles[j].volume;

            this.logger.debug(
              `[Accumulation] ${symbol} Recovery check at bar ${j}: ` +
                `close=${candles[j].close.toFixed(2)}, ` +
                `vol=${recoveryVolume.toFixed(0)}, avgVol=${avgVolume.toFixed(0)} ` +
                `(${(recoveryVolume / avgVolume).toFixed(2)}x)`,
              'AccumulationDetector',
            );

            if (recoveryVolume >= avgVolume * this.config.springVolumeMultiple) {
              recovered = true;
              break;
            }
          }
        }

        if (recovered) {
          return { detected: true, springLow: candle.low };
        }
      }
    }

    return { detected: false, springLow: 0 };
  }
}
