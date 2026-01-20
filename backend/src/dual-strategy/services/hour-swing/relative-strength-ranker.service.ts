import { Injectable } from '@nestjs/common';
import { HOUR_SWING_CONFIG } from '../../constants/hour-swing.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { DataCacheService } from '../data/data-cache.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * Relative Strength Ranker
 * Follows leaders when BTC turns
 */
@Injectable()
export class RelativeStrengthRankerService {
  private readonly config = HOUR_SWING_CONFIG.subStrategies.relativeStrength;

  constructor(
    private readonly cacheService: DataCacheService,
    private readonly logger: CustomLoggerService,
  ) {}

  async analyze(
    symbol: string,
    currentPrice: number,
    btcCandles: Candle[],
  ): Promise<TradingSignal> {
    if (!this.config.enabled) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[RelativeStrength] ${symbol} Starting analysis`,
      'RelativeStrengthRanker',
    );

    // Get symbol candles
    const symbolCandles = await this.cacheService.getRecentCandles(
      symbol,
      this.config.rsTimeframe as any,
      this.config.rsPeriod,
    );

    if (!symbolCandles || symbolCandles.length < this.config.rsPeriod) {
      return { detected: false } as any;
    }

    // 1. Check BTC turn
    const btcTurn = this.detectBtcTurn(btcCandles, symbol);

    this.logger.debug(
      `[RelativeStrength] ${symbol} BTC turn: detected=${btcTurn.detected}, direction=${btcTurn.direction}`,
      'RelativeStrengthRanker',
    );

    if (!btcTurn.detected || btcTurn.direction === 'NEUTRAL') {
      return { detected: false } as any;
    }

    // 2. Calculate relative strength vs BTC
    const rs = this.calculateRelativeStrength(symbolCandles, btcCandles);

    this.logger.debug(
      `[RelativeStrength] ${symbol} RS score: ${rs.toFixed(2)}% ` +
        `(threshold: ${btcTurn.direction === 'UP' ? `>=${this.config.topRsCount}` : `<=-${this.config.bottomRsCount}`})`,
      'RelativeStrengthRanker',
    );

    // 3. Check if symbol is in top/bottom RS
    const isLeader = btcTurn.direction === 'UP'
      ? rs >= this.config.topRsCount  // Top RS for long
      : rs <= -this.config.bottomRsCount; // Bottom RS for short

    if (!isLeader) {
      return { detected: false } as any;
    }

    this.logger.log(
      `[RelativeStrength] ${symbol} ⭐ Leader detected! RS=${rs.toFixed(2)}% (BTC ${btcTurn.direction})`,
      'RelativeStrengthRanker',
    );

    // 4. Check for pullback if required
    if (this.config.requirePullback) {
      const atr = Indicators.calculateAtr(symbolCandles, 14);
      const pullback = CandleAnalyzer.isPullback(symbolCandles, btcTurn.direction as 'UP' | 'DOWN', {
        minDepthAtr: 0.3,
        maxDepthAtr: 1.5,
        atr,
      });

      this.logger.debug(
        `[RelativeStrength] ${symbol} Pullback check: detected=${pullback.isPullback}`,
        'RelativeStrengthRanker',
      );

      if (!pullback.isPullback) {
        return { detected: false } as any;
      }
    }

    // 5. CVD confirmation
    if (this.config.cvdConfirmRequired) {
      const cvdValues = Indicators.calculateCvd(symbolCandles.slice(-5));
      const cvdTrend = Indicators.analyzeCvdTrend(cvdValues);
      const expectedTrend = btcTurn.direction === 'UP' ? 'RISING' : 'FALLING';

      this.logger.debug(
        `[RelativeStrength] ${symbol} CVD check: trend=${cvdTrend}, expected=${expectedTrend}`,
        'RelativeStrengthRanker',
      );

      if (cvdTrend !== expectedTrend) {
        return { detected: false } as any;
      }
    }

    // 6. Calculate TP/SL
    const direction = btcTurn.direction === 'UP' ? TradeDirection.LONG : TradeDirection.SHORT;
    const atr = Indicators.calculateAtr(symbolCandles, 14);
    const slDistance = atr * this.config.tpSl.slAtrMultiple;

    const slPrice = direction === TradeDirection.LONG
      ? currentPrice - slDistance
      : currentPrice + slDistance;

    const tp1Price = direction === TradeDirection.LONG
      ? currentPrice + slDistance * this.config.tpSl.tp1RR
      : currentPrice - slDistance * this.config.tpSl.tp1RR;

    const tp2Price = direction === TradeDirection.LONG
      ? currentPrice + slDistance * this.config.tpSl.tp2RR
      : currentPrice - slDistance * this.config.tpSl.tp2RR;

    this.logger.log(
      `[RelativeStrength] ${symbol} ✅ Signal generated! ` +
        `Direction=${direction}, Entry=${currentPrice.toFixed(2)}, ` +
        `SL=${slPrice.toFixed(2)}, TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
        `RS=${rs.toFixed(2)}%`,
      'RelativeStrengthRanker',
    );

    return {
      detected: true,
      strategyType: StrategyType.HOUR_SWING,
      subStrategy: 'relative_strength',
      symbol,
      direction,
      entryPrice: currentPrice,
      slPrice,
      tp1Price,
      tp2Price,
      useTrailing: false,
      confidence: 70,
      riskRewardRatio: this.config.tpSl.tp2RR,
      metadata: {
        atr,
        relativeStrength: rs,
        btcTurnDirection: btcTurn.direction,
      },
    };
  }

  /**
   * Detect BTC turn (trend change)
   */
  private detectBtcTurn(btcCandles: Candle[], symbol: string): {
    detected: boolean;
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
  } {
    if (btcCandles.length < this.config.btcTurnConfirmBars + 10) {
      return { detected: false, direction: 'NEUTRAL' };
    }

    // Check EMA cross
    const closes = btcCandles.map((c) => c.close);
    const emaFast = Indicators.calculateEma(closes, this.config.btcEmaFast);
    const emaSlow = Indicators.calculateEma(closes, this.config.btcEmaSlow);

    if (emaFast.length < this.config.btcTurnConfirmBars || emaSlow.length < this.config.btcTurnConfirmBars) {
      return { detected: false, direction: 'NEUTRAL' };
    }

    const currentFast = emaFast[emaFast.length - 1];
    const currentSlow = emaSlow[emaSlow.length - 1];

    this.logger.debug(
      `[RelativeStrength] ${symbol} BTC EMA: fast=${currentFast.toFixed(2)}, slow=${currentSlow.toFixed(2)}`,
      'RelativeStrengthRanker',
    );

    // Check last N bars for consistent cross
    let bullishCross = true;
    let bearishCross = true;

    for (let i = 1; i <= this.config.btcTurnConfirmBars; i++) {
      const fastIdx = emaFast.length - i;
      const slowIdx = emaSlow.length - i;

      if (emaFast[fastIdx] <= emaSlow[slowIdx]) {
        bullishCross = false;
      }
      if (emaFast[fastIdx] >= emaSlow[slowIdx]) {
        bearishCross = false;
      }
    }

    if (bullishCross) {
      this.logger.debug(
        `[RelativeStrength] ${symbol} BTC bullish cross detected (EMA${this.config.btcEmaFast} > EMA${this.config.btcEmaSlow})`,
        'RelativeStrengthRanker',
      );
      return { detected: true, direction: 'UP' };
    } else if (bearishCross) {
      this.logger.debug(
        `[RelativeStrength] ${symbol} BTC bearish cross detected (EMA${this.config.btcEmaFast} < EMA${this.config.btcEmaSlow})`,
        'RelativeStrengthRanker',
      );
      return { detected: true, direction: 'DOWN' };
    }

    return { detected: false, direction: 'NEUTRAL' };
  }

  /**
   * Calculate relative strength vs BTC with Beta coefficient
   * Returns normalized RS score
   *
   * Beta measures how much symbol moves relative to BTC:
   * - Beta > 1: Symbol moves more than BTC (high leverage)
   * - Beta = 1: Symbol moves same as BTC
   * - Beta < 1: Symbol moves less than BTC (low leverage)
   *
   * Alpha = Actual Performance - (Beta * BTC Performance)
   * Positive Alpha = Outperformance, Negative Alpha = Underperformance
   */
  private calculateRelativeStrength(symbolCandles: Candle[], btcCandles: Candle[]): number {
    const period = Math.min(symbolCandles.length, btcCandles.length, this.config.rsPeriod);

    if (period < 10) {
      return 0;
    }

    // Calculate returns for both symbol and BTC
    const symbolReturns: number[] = [];
    const btcReturns: number[] = [];

    for (let i = 1; i < period; i++) {
      const symbolIdx = symbolCandles.length - period + i;
      const btcIdx = btcCandles.length - period + i;

      const symbolReturn = (symbolCandles[symbolIdx].close - symbolCandles[symbolIdx - 1].close) /
                           symbolCandles[symbolIdx - 1].close;
      const btcReturn = (btcCandles[btcIdx].close - btcCandles[btcIdx - 1].close) /
                        btcCandles[btcIdx - 1].close;

      symbolReturns.push(symbolReturn);
      btcReturns.push(btcReturn);
    }

    // Calculate Beta: Covariance(Symbol, BTC) / Variance(BTC)
    const beta = this.calculateBeta(symbolReturns, btcReturns);

    // Calculate cumulative performance
    const symbolStart = symbolCandles[symbolCandles.length - period].close;
    const symbolEnd = symbolCandles[symbolCandles.length - 1].close;
    const symbolPerformance = (symbolEnd - symbolStart) / symbolStart;

    const btcStart = btcCandles[btcCandles.length - period].close;
    const btcEnd = btcCandles[btcCandles.length - 1].close;
    const btcPerformance = (btcEnd - btcStart) / btcStart;

    // Alpha = Actual Performance - (Beta * BTC Performance)
    // Positive alpha = outperformance, negative alpha = underperformance
    const alpha = symbolPerformance - (beta * btcPerformance);

    // Return alpha as percentage (multiplied by 100 for readability)
    return alpha * 100;
  }

  /**
   * Calculate Beta coefficient
   * Beta = Covariance(Symbol, BTC) / Variance(BTC)
   */
  private calculateBeta(symbolReturns: number[], btcReturns: number[]): number {
    if (symbolReturns.length !== btcReturns.length || symbolReturns.length === 0) {
      return 1; // Default to 1 if no data
    }

    // Calculate means
    const symbolMean = symbolReturns.reduce((a, b) => a + b, 0) / symbolReturns.length;
    const btcMean = btcReturns.reduce((a, b) => a + b, 0) / btcReturns.length;

    // Calculate covariance
    let covariance = 0;
    for (let i = 0; i < symbolReturns.length; i++) {
      covariance += (symbolReturns[i] - symbolMean) * (btcReturns[i] - btcMean);
    }
    covariance /= symbolReturns.length;

    // Calculate BTC variance
    let btcVariance = 0;
    for (let i = 0; i < btcReturns.length; i++) {
      btcVariance += Math.pow(btcReturns[i] - btcMean, 2);
    }
    btcVariance /= btcReturns.length;

    if (btcVariance === 0) {
      return 1; // Avoid division by zero
    }

    return covariance / btcVariance;
  }
}
