import { Injectable } from '@nestjs/common';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Distribution Detector - Wyckoff Distribution Pattern
 * Opposite of accumulation - detects smart money distribution
 */
@Injectable()
export class DistributionDetectorService {
  private readonly config = CYCLE_RIDER_CONFIG.subStrategies.distribution;

  constructor(private readonly logger: CustomLoggerService) {}

  async detect(candles: Candle[], currentPrice: number): Promise<TradingSignal> {
    const symbol = candles[0]?.symbol || 'UNKNOWN';

    if (!this.config.enabled || candles.length < this.config.boxPeriod + 10) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[Distribution] ${symbol} Starting analysis (${candles.length} candles)`,
      'DistributionDetector',
    );

    // 1. Box range formation check
    const boxCandles = candles.slice(-this.config.boxPeriod);
    const atr = Indicators.calculateAtr(candles, 14);
    const boxAnalysis = CandleAnalyzer.isInBoxRange(boxCandles, this.config.boxRangeMaxAtr, atr);

    this.logger.debug(
      `[Distribution] ${symbol} Box analysis: inBox=${boxAnalysis.inBox}, ` +
        `range=${boxAnalysis.boxRange?.toFixed(2) || 'N/A'}, ` +
        `maxAllowed=${(atr * this.config.boxRangeMaxAtr).toFixed(2)}, ` +
        `ATR=${atr.toFixed(2)}`,
      'DistributionDetector',
    );

    if (!boxAnalysis.inBox) {
      return { detected: false } as any;
    }

    const { boxHigh, boxLow, boxRange } = boxAnalysis;

    // 2. Resistance test count
    const resistanceTests = CandleAnalyzer.countLevelTests(
      boxCandles,
      boxHigh,
      this.config.resistanceTestThreshold,
      'resistance',
    );

    this.logger.debug(
      `[Distribution] ${symbol} Resistance tests: ${resistanceTests}/${this.config.minResistanceTests} ` +
        `(boxHigh=${boxHigh.toFixed(2)})`,
      'DistributionDetector',
    );

    if (resistanceTests < this.config.minResistanceTests) {
      return { detected: false } as any;
    }

    // 3. CVD falling trend (price sideways + CVD falling = distribution)
    const cvdValues = Indicators.calculateCvd(candles.slice(-this.config.cvdPeriod - 5));
    const cvdTrend = Indicators.analyzeCvdTrend(cvdValues.slice(-this.config.cvdPeriod));
    const recentCvd = cvdValues.slice(-5).map((v) => v.toFixed(0));

    this.logger.debug(
      `[Distribution] ${symbol} CVD trend: ${cvdTrend}, recent=[${recentCvd.join(', ')}]`,
      'DistributionDetector',
    );

    if (cvdTrend !== 'FALLING') {
      return { detected: false } as any;
    }

    // 4. UTAD detection (Upthrust After Distribution)
    const utadData = this.detectUTAD(candles, boxHigh, atr, symbol);
    if (!utadData.detected) {
      this.logger.debug(
        `[Distribution] ${symbol} No UTAD pattern found`,
        'DistributionDetector',
      );
      return { detected: false } as any;
    }

    this.logger.log(
      `[Distribution] ${symbol} 💥 UTAD detected! ` +
        `High=${utadData.utadHigh.toFixed(2)}, BoxHigh=${boxHigh.toFixed(2)}`,
      'DistributionDetector',
    );

    // 5. Calculate confidence
    const confidence = Math.min(
      resistanceTests * 10 +
        30 +
        (cvdTrend === 'FALLING' ? 30 : 0) +
        20,
      100,
    );

    this.logger.debug(
      `[Distribution] ${symbol} Confidence: ${confidence}% (min=${this.config.minConfidence}%)`,
      'DistributionDetector',
    );

    if (confidence < this.config.minConfidence) {
      return { detected: false } as any;
    }

    // 6. Calculate TP/SL
    const slPrice = utadData.utadHigh + atr * this.config.tpSl.slAtrMultiple;
    const tp1Price = boxLow;
    const tp2Price = boxLow - boxRange;

    this.logger.log(
      `[Distribution] ${symbol} ✅ Signal generated! ` +
        `Entry=${currentPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}, ` +
        `TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, Confidence=${confidence}%`,
      'DistributionDetector',
    );

    return {
      detected: true,
      strategyType: StrategyType.CYCLE_RIDER,
      subStrategy: 'distribution',
      symbol: candles[0].symbol,
      direction: TradeDirection.SHORT,
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
        resistanceTests,
        cvdTrend,
        utadHigh: utadData.utadHigh,
      },
    };
  }

  /**
   * Detect UTAD pattern (Upthrust After Distribution)
   * UTAD = Brief break above resistance followed by rejection
   */
  private detectUTAD(
    candles: Candle[],
    boxHigh: number,
    atr: number,
    symbol: string,
  ): { detected: boolean; utadHigh: number } {
    const minBreak = boxHigh * (1 + this.config.utadBreakPercent);
    const maxBreak = boxHigh * (1 + this.config.utadMaxBreakPercent);

    this.logger.debug(
      `[Distribution] ${symbol} UTAD search: boxHigh=${boxHigh.toFixed(2)}, ` +
        `minBreak=${minBreak.toFixed(2)}, maxBreak=${maxBreak.toFixed(2)}`,
      'DistributionDetector',
    );

    // Look back 10 bars for UTAD
    for (let i = candles.length - 4; i >= Math.max(0, candles.length - 10); i--) {
      const candle = candles[i];

      // Check if high broke above box but within acceptable range
      if (candle.high > minBreak && candle.high < maxBreak) {
        this.logger.debug(
          `[Distribution] ${symbol} Potential UTAD at bar ${i}: ` +
            `high=${candle.high.toFixed(2)} (broke above ${boxHigh.toFixed(2)})`,
          'DistributionDetector',
        );

        // Check for rejection in next 3 bars
        let rejected = false;
        const rejectionBars = Math.min(i + this.config.utadRejectionBars, candles.length - 1);

        for (let j = i + 1; j <= rejectionBars; j++) {
          if (candles[j].close < boxHigh) {
            // Check volume spike on rejection
            const avgVolume =
              candles
                .slice(Math.max(0, i - 10), i)
                .reduce((sum, c) => sum + c.volume, 0) / 10;
            const rejectionVolume = candles[j].volume;

            this.logger.debug(
              `[Distribution] ${symbol} Rejection check at bar ${j}: ` +
                `close=${candles[j].close.toFixed(2)}, ` +
                `vol=${rejectionVolume.toFixed(0)}, avgVol=${avgVolume.toFixed(0)} ` +
                `(${(rejectionVolume / avgVolume).toFixed(2)}x)`,
              'DistributionDetector',
            );

            if (rejectionVolume >= avgVolume * this.config.utadVolumeMultiple) {
              rejected = true;
              break;
            }
          }
        }

        if (rejected) {
          return { detected: true, utadHigh: candle.high };
        }
      }
    }

    return { detected: false, utadHigh: 0 };
  }
}
