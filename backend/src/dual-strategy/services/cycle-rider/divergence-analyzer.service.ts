import { Injectable } from '@nestjs/common';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Divergence Analyzer
 * Detects price/indicator divergences (RSI, CVD)
 */
@Injectable()
export class DivergenceAnalyzerService {
  private readonly config = CYCLE_RIDER_CONFIG.subStrategies.divergence;

  constructor(private readonly logger: CustomLoggerService) {}

  async detect(candles: Candle[], currentPrice: number): Promise<TradingSignal> {
    const symbol = candles[0]?.symbol || 'UNKNOWN';

    if (!this.config.enabled || candles.length < this.config.maxSwingDistance + 10) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[Divergence] ${symbol} Starting analysis (${candles.length} candles)`,
      'DivergenceAnalyzer',
    );

    const atr = Indicators.calculateAtr(candles, 14);
    const rsi = Indicators.calculateRsi(candles, this.config.rsiPeriod);

    // 1. Find swing points
    const swingPoints = Indicators.findSwingPoints(candles, this.config.swingLookback);

    this.logger.debug(
      `[Divergence] ${symbol} Swing points: ${swingPoints.highs.length} highs, ${swingPoints.lows.length} lows, RSI=${rsi.toFixed(2)}`,
      'DivergenceAnalyzer',
    );

    // Need at least 2 swing points
    if (swingPoints.highs.length < 2 && swingPoints.lows.length < 2) {
      return { detected: false } as any;
    }

    // 2. Calculate RSI values for the candles
    const rsiValues: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const rsiVal = Indicators.calculateRsi(candles.slice(0, i + 1), this.config.rsiPeriod);
      rsiValues.push(rsiVal);
    }

    // 3. Check for bullish divergence
    const bullishDiv = this.checkBullishDivergence(candles, rsiValues, swingPoints, rsi, symbol);
    if (bullishDiv.detected) {
      this.logger.debug(
        `[Divergence] ${symbol} Bullish divergence detected! Strength=${bullishDiv.strength.toFixed(0)}`,
        'DivergenceAnalyzer',
      );

      // Check RVol (Relative Volume) - require reasonable volume
      const rvolData = Indicators.calculateRVol(candles, 20);

      this.logger.debug(
        `[Divergence] ${symbol} RVol check: ${rvolData.rvol.toFixed(2)} (min=1.5)`,
        'DivergenceAnalyzer',
      );

      if (rvolData.rvol < 1.5) {
        // Volume too low, skip
        return { detected: false } as any;
      }

      // Check ADX (trend strength) - divergence works in ranging/weak trend
      // Use lower threshold (15) since divergence is a reversal pattern
      const adxData = Indicators.calculateAdx(candles, 14);

      this.logger.debug(
        `[Divergence] ${symbol} ADX check: ${adxData.adx.toFixed(2)} (max=40)`,
        'DivergenceAnalyzer',
      );

      if (adxData.adx > 40) {
        // Trend too strong for divergence reversal, skip
        return { detected: false } as any;
      }

      // Require reversal candle pattern
      const pattern = CandleAnalyzer.detectReversalPattern(candles);

      this.logger.debug(
        `[Divergence] ${symbol} Pattern check: ${pattern.pattern || 'NONE'} (direction=${pattern.direction || 'NONE'})`,
        'DivergenceAnalyzer',
      );

      if (
        pattern.pattern &&
        pattern.direction === 'BULLISH' &&
        this.config.confirmationPatterns.includes(pattern.pattern)
      ) {
        const slPrice = currentPrice - atr * this.config.tpSl.slAtrMultiple;
        const slDistance = currentPrice - slPrice;
        const tp1Price = currentPrice + slDistance * this.config.tpSl.tp1RR;
        const tp2Price = currentPrice + slDistance * this.config.tpSl.tp2RR;

        this.logger.log(
          `[Divergence] ${symbol} ✅ BULLISH signal generated! ` +
            `Pattern=${pattern.pattern}, Entry=${currentPrice.toFixed(2)}, ` +
            `SL=${slPrice.toFixed(2)}, TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
            `Strength=${bullishDiv.strength.toFixed(0)}`,
          'DivergenceAnalyzer',
        );

        return {
          detected: true,
          strategyType: StrategyType.CYCLE_RIDER,
          subStrategy: 'divergence',
          symbol: candles[0].symbol,
          direction: TradeDirection.LONG,
          entryPrice: currentPrice,
          slPrice,
          tp1Price,
          tp2Price,
          useTrailing: this.config.tpSl.useTrailing,
          confidence: bullishDiv.strength,
          riskRewardRatio: this.config.tpSl.tp2RR,
          metadata: {
            atr,
            rsi,
            divergenceType: 'BULLISH',
            reversalPattern: pattern.pattern,
            strength: bullishDiv.strength,
            rvol: rvolData.rvol,
            adx: adxData.adx,
          },
        };
      }
    }

    // 4. Check for bearish divergence
    const bearishDiv = this.checkBearishDivergence(candles, rsiValues, swingPoints, rsi, symbol);
    if (bearishDiv.detected) {
      this.logger.debug(
        `[Divergence] ${symbol} Bearish divergence detected! Strength=${bearishDiv.strength.toFixed(0)}`,
        'DivergenceAnalyzer',
      );

      // Check RVol (Relative Volume) - require reasonable volume
      const rvolData = Indicators.calculateRVol(candles, 20);

      this.logger.debug(
        `[Divergence] ${symbol} RVol check: ${rvolData.rvol.toFixed(2)} (min=1.5)`,
        'DivergenceAnalyzer',
      );

      if (rvolData.rvol < 1.5) {
        // Volume too low, skip
        return { detected: false } as any;
      }

      // Check ADX (trend strength) - divergence works in ranging/weak trend
      // Use lower threshold (15) since divergence is a reversal pattern
      const adxData = Indicators.calculateAdx(candles, 14);

      this.logger.debug(
        `[Divergence] ${symbol} ADX check: ${adxData.adx.toFixed(2)} (max=40)`,
        'DivergenceAnalyzer',
      );

      if (adxData.adx > 40) {
        // Trend too strong for divergence reversal, skip
        return { detected: false } as any;
      }

      // Require reversal candle pattern
      const pattern = CandleAnalyzer.detectReversalPattern(candles);

      this.logger.debug(
        `[Divergence] ${symbol} Pattern check: ${pattern.pattern || 'NONE'} (direction=${pattern.direction || 'NONE'})`,
        'DivergenceAnalyzer',
      );

      if (
        pattern.pattern &&
        pattern.direction === 'BEARISH' &&
        this.config.confirmationPatterns.includes(pattern.pattern)
      ) {
        const slPrice = currentPrice + atr * this.config.tpSl.slAtrMultiple;
        const slDistance = slPrice - currentPrice;
        const tp1Price = currentPrice - slDistance * this.config.tpSl.tp1RR;
        const tp2Price = currentPrice - slDistance * this.config.tpSl.tp2RR;

        this.logger.log(
          `[Divergence] ${symbol} ✅ BEARISH signal generated! ` +
            `Pattern=${pattern.pattern}, Entry=${currentPrice.toFixed(2)}, ` +
            `SL=${slPrice.toFixed(2)}, TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
            `Strength=${bearishDiv.strength.toFixed(0)}`,
          'DivergenceAnalyzer',
        );

        return {
          detected: true,
          strategyType: StrategyType.CYCLE_RIDER,
          subStrategy: 'divergence',
          symbol: candles[0].symbol,
          direction: TradeDirection.SHORT,
          entryPrice: currentPrice,
          slPrice,
          tp1Price,
          tp2Price,
          useTrailing: this.config.tpSl.useTrailing,
          confidence: bearishDiv.strength,
          riskRewardRatio: this.config.tpSl.tp2RR,
          metadata: {
            atr,
            rsi,
            divergenceType: 'BEARISH',
            reversalPattern: pattern.pattern,
            strength: bearishDiv.strength,
            rvol: rvolData.rvol,
            adx: adxData.adx,
          },
        };
      }
    }

    return { detected: false } as any;
  }

  /**
   * Check for bullish divergence
   * Price: Lower Low, RSI: Higher Low
   */
  private checkBullishDivergence(
    candles: Candle[],
    rsiValues: number[],
    swingPoints: { highs: number[]; lows: number[] },
    currentRsi: number,
    symbol: string,
  ): { detected: boolean; strength: number } {
    const { lows } = swingPoints;

    if (lows.length < 2) {
      return { detected: false, strength: 0 };
    }

    const lastLowIdx = lows[lows.length - 1];
    const prevLowIdx = lows[lows.length - 2];

    // Check swing distance
    const distance = lastLowIdx - prevLowIdx;
    if (distance < this.config.minSwingDistance || distance > this.config.maxSwingDistance) {
      return { detected: false, strength: 0 };
    }

    // Price makes lower low
    const priceLowerLow = candles[lastLowIdx].low < candles[prevLowIdx].low;

    // RSI makes higher low
    const rsiHigherLow = rsiValues[lastLowIdx] > rsiValues[prevLowIdx];

    // RSI should be oversold
    const rsiOversold = currentRsi < this.config.rsiOversold;

    this.logger.debug(
      `[Divergence] ${symbol} Bullish check: priceLowerLow=${priceLowerLow} ` +
        `(${candles[lastLowIdx].low.toFixed(2)} vs ${candles[prevLowIdx].low.toFixed(2)}), ` +
        `rsiHigherLow=${rsiHigherLow} ` +
        `(${rsiValues[lastLowIdx].toFixed(2)} vs ${rsiValues[prevLowIdx].toFixed(2)}), ` +
        `rsiOversold=${rsiOversold} (${currentRsi.toFixed(2)} < ${this.config.rsiOversold})`,
      'DivergenceAnalyzer',
    );

    if (priceLowerLow && rsiHigherLow && rsiOversold) {
      // Calculate price divergence
      const priceDiff = Math.abs(
        (candles[lastLowIdx].low - candles[prevLowIdx].low) / candles[prevLowIdx].low,
      );

      if (priceDiff >= this.config.priceDivergenceMin) {
        const strength = Math.min(70 + priceDiff * 100, 100);
        if (strength >= this.config.minStrength) {
          return { detected: true, strength };
        }
      }
    }

    return { detected: false, strength: 0 };
  }

  /**
   * Check for bearish divergence
   * Price: Higher High, RSI: Lower High
   */
  private checkBearishDivergence(
    candles: Candle[],
    rsiValues: number[],
    swingPoints: { highs: number[]; lows: number[] },
    currentRsi: number,
    symbol: string,
  ): { detected: boolean; strength: number } {
    const { highs } = swingPoints;

    if (highs.length < 2) {
      return { detected: false, strength: 0 };
    }

    const lastHighIdx = highs[highs.length - 1];
    const prevHighIdx = highs[highs.length - 2];

    // Check swing distance
    const distance = lastHighIdx - prevHighIdx;
    if (distance < this.config.minSwingDistance || distance > this.config.maxSwingDistance) {
      return { detected: false, strength: 0 };
    }

    // Price makes higher high
    const priceHigherHigh = candles[lastHighIdx].high > candles[prevHighIdx].high;

    // RSI makes lower high
    const rsiLowerHigh = rsiValues[lastHighIdx] < rsiValues[prevHighIdx];

    // RSI should be overbought
    const rsiOverbought = currentRsi > this.config.rsiOverbought;

    this.logger.debug(
      `[Divergence] ${symbol} Bearish check: priceHigherHigh=${priceHigherHigh} ` +
        `(${candles[lastHighIdx].high.toFixed(2)} vs ${candles[prevHighIdx].high.toFixed(2)}), ` +
        `rsiLowerHigh=${rsiLowerHigh} ` +
        `(${rsiValues[lastHighIdx].toFixed(2)} vs ${rsiValues[prevHighIdx].toFixed(2)}), ` +
        `rsiOverbought=${rsiOverbought} (${currentRsi.toFixed(2)} > ${this.config.rsiOverbought})`,
      'DivergenceAnalyzer',
    );

    if (priceHigherHigh && rsiLowerHigh && rsiOverbought) {
      // Calculate price divergence
      const priceDiff = Math.abs(
        (candles[lastHighIdx].high - candles[prevHighIdx].high) / candles[prevHighIdx].high,
      );

      if (priceDiff >= this.config.priceDivergenceMin) {
        const strength = Math.min(70 + priceDiff * 100, 100);
        if (strength >= this.config.minStrength) {
          return { detected: true, strength };
        }
      }
    }

    return { detected: false, strength: 0 };
  }
}
