import {
  IStrategy,
  IDataProvider,
  TradingSignal,
  TradeDirection,
  Candle,
} from '../core/interfaces';
import {
  calculateEMA,
  calculateATR,
  calculateATRStopLoss,
  calculateTakeProfit,
  calculateADX,
  getTrendDirection,
} from '../core/indicators';
import { analyzeFunding, adjustForFunding } from '../core/indicators';
import { CORE_TREND_CONFIG, CoreTrendConfig } from './core-trend.config';

/**
 * Core Trend Strategy
 *
 * Multi-timeframe trend following strategy based on:
 * - 1D EMA 50/200 for trend direction
 * - 4H for entry triggers (pullback/breakout)
 *
 * Entry conditions:
 * 1. 1D trend established (EMA50 > EMA200 for long, vice versa for short)
 * 2. 4H pullback to fast EMA or breakout re-entry
 * 3. ADX confirms trend strength
 *
 * Exit:
 * - Initial SL: 2 ATR
 * - TP1 at 1R: Close 30%
 * - Trail remaining at 2.5 ATR
 * - Time stop: 30 4H bars
 */
export class CoreTrendStrategy implements IStrategy {
  readonly name = 'CORE_TREND';
  private config: CoreTrendConfig;

  constructor(config: Partial<CoreTrendConfig> = {}) {
    this.config = { ...CORE_TREND_CONFIG, ...config };
  }

  getSignalTimeframe(): string {
    return this.config.timeframes.signal;
  }

  getEntryTimeframe(): string {
    return this.config.timeframes.entry;
  }

  /**
   * Generate trading signal
   */
  generateSignal(symbol: string, dataProvider: IDataProvider): TradingSignal | null {
    // Get candles for both timeframes
    const candles1d = dataProvider.getCandles(symbol, '1d', 250);
    const candles4h = dataProvider.getCandles(symbol, '4h', 100);

    if (candles1d.length < this.config.trend.emaSlow1d + 10) {
      return null;
    }

    if (candles4h.length < this.config.entry.atrLen4h + 10) {
      return null;
    }

    // Step 1: Determine trend direction from 1D
    const trendAnalysis = this.analyzeTrend(candles1d);
    if (!trendAnalysis.hasTrend) {
      return null;
    }

    // Step 2: Check entry conditions on 4H
    const entryAnalysis = this.analyzeEntry(candles4h, trendAnalysis.direction);
    if (!entryAnalysis.hasEntry) {
      return null;
    }

    // Step 3: Calculate trade parameters
    const currentPrice = dataProvider.getCurrentPrice(symbol);
    if (!currentPrice) {
      return null;
    }

    const atr4h = calculateATR(candles4h, this.config.entry.atrLen4h);
    if (!atr4h) {
      return null;
    }

    // Step 4: Check funding overlay
    const fundingRate = dataProvider.getFundingRate(symbol);
    const fundingHistory = dataProvider.getFundingHistory(symbol, 200);
    const fundingAnalysis = fundingRate !== null && fundingHistory.length > 50
      ? analyzeFunding(fundingRate, fundingHistory, 0.9, 0.1, false)
      : null;

    // Block trade if funding is extremely unfavorable
    if (fundingAnalysis?.action === 'BLOCK') {
      return null;
    }

    // Calculate SL, TP
    const slPrice = calculateATRStopLoss(
      currentPrice,
      atr4h,
      this.config.exit.slAtrMult,
      trendAnalysis.direction,
    );

    const tp1Price = calculateTakeProfit(
      currentPrice,
      slPrice,
      this.config.exit.tp1R,
      trendAnalysis.direction,
    );

    // Adjust for funding if needed
    let tp1QtyPct = this.config.exit.tp1QtyPct;
    let trailAtrMult = this.config.exit.trailAtrMult;

    if (fundingAnalysis?.action === 'TIGHTEN') {
      const adjusted = adjustForFunding(
        fundingAnalysis,
        tp1QtyPct,
        trailAtrMult,
        0.1,
        0.3,
      );
      tp1QtyPct = adjusted.tp1QtyPercent;
      trailAtrMult = adjusted.trailAtrMult;
    }

    // Calculate confidence
    const confidence = this.calculateConfidence(trendAnalysis, entryAnalysis);

    return {
      detected: true,
      strategyType: 'CORE_TREND',
      subStrategy: entryAnalysis.entryType,
      symbol,
      direction: trendAnalysis.direction,
      entryPrice: currentPrice,
      slPrice,
      slAtrMult: this.config.exit.slAtrMult,
      tp1Price,
      tp1QtyPercent: tp1QtyPct,
      trailAtrMult,
      timeStopBars: this.config.exit.timeStopBars4h,
      fundingAction: fundingAnalysis?.action || 'ALLOW',
      confidence,
      metadata: {
        ema50: trendAnalysis.emaFast,
        ema200: trendAnalysis.emaSlow,
        atr: atr4h,
        atrPercent: atr4h / currentPrice,
        adx: trendAnalysis.adx,
        trend1d: trendAnalysis.direction === 'LONG' ? 'UP' : 'DOWN',
        pullbackDepth: entryAnalysis.pullbackDepth,
        entryQuality: entryAnalysis.quality,
        fundingRate: fundingRate || undefined,
        fundingPctl: fundingAnalysis?.percentile,
        leverage: this.config.position.leverage,
        maxMarginUsd: this.config.position.maxMarginUsd,
        signalTime: dataProvider.getCurrentTime(),
      },
    };
  }

  /**
   * Analyze 1D trend
   */
  private analyzeTrend(candles1d: Candle[]): {
    hasTrend: boolean;
    direction: TradeDirection;
    emaFast: number;
    emaSlow: number;
    adx: number;
    strength: number;
  } {
    const emaFast = calculateEMA(candles1d, this.config.trend.emaFast1d);
    const emaSlow = calculateEMA(candles1d, this.config.trend.emaSlow1d);
    const adxResult = calculateADX(candles1d, 14);

    if (!emaFast || !emaSlow || !adxResult) {
      return {
        hasTrend: false,
        direction: 'LONG',
        emaFast: 0,
        emaSlow: 0,
        adx: 0,
        strength: 0,
      };
    }

    const currentPrice = candles1d[candles1d.length - 1].close;
    const emaSeparationPct = Math.abs(emaFast - emaSlow) / currentPrice;

    // Require minimum EMA separation
    if (emaSeparationPct < this.config.trend.minEmaSeparationPct / 100) {
      return {
        hasTrend: false,
        direction: 'LONG',
        emaFast,
        emaSlow,
        adx: adxResult.adx,
        strength: 0,
      };
    }

    // Require minimum ADX for trend strength (30+ for strong trend)
    if (adxResult.adx < 30) {
      return {
        hasTrend: false,
        direction: 'LONG',
        emaFast,
        emaSlow,
        adx: adxResult.adx,
        strength: 0,
      };
    }

    const direction: TradeDirection = emaFast > emaSlow ? 'LONG' : 'SHORT';

    // Calculate trend strength (0-1)
    const strength = Math.min(adxResult.adx / 50, 1);

    return {
      hasTrend: true,
      direction,
      emaFast,
      emaSlow,
      adx: adxResult.adx,
      strength,
    };
  }

  /**
   * Analyze 4H entry conditions
   */
  private analyzeEntry(
    candles4h: Candle[],
    trendDirection: TradeDirection,
  ): {
    hasEntry: boolean;
    entryType: string;
    pullbackDepth: number;
    quality: 'HIGH' | 'MEDIUM' | 'LOW';
  } {
    const ema20_4h = calculateEMA(candles4h, 20);
    const atr4h = calculateATR(candles4h, this.config.entry.atrLen4h);

    if (!ema20_4h || !atr4h) {
      return { hasEntry: false, entryType: '', pullbackDepth: 0, quality: 'LOW' };
    }

    const currentCandle = candles4h[candles4h.length - 1];
    const currentPrice = currentCandle.close;
    const previousCandle = candles4h[candles4h.length - 2];

    // Calculate pullback depth in ATR
    const pullbackDepth = Math.abs(currentPrice - ema20_4h) / atr4h;

    // Entry type 1: Pullback to EMA
    // Price has pulled back within 1 ATR of EMA20 and is starting to reverse
    const isPullbackToEma =
      pullbackDepth <= this.config.entry.pullbackAtrMult;

    // Check for reversal candle pattern
    const isReversalCandle =
      trendDirection === 'LONG'
        ? currentCandle.close > currentCandle.open &&
          currentCandle.close > previousCandle.close
        : currentCandle.close < currentCandle.open &&
          currentCandle.close < previousCandle.close;

    // Entry type 2: Breakout re-entry
    // Price broke above/below recent range and is continuing
    const recentHigh = Math.max(...candles4h.slice(-10).map((c) => c.high));
    const recentLow = Math.min(...candles4h.slice(-10).map((c) => c.low));

    const isBreakoutReentry =
      trendDirection === 'LONG'
        ? currentPrice > recentHigh &&
          currentCandle.close > previousCandle.high
        : currentPrice < recentLow &&
          currentCandle.close < previousCandle.low;

    // Determine entry type and quality
    let hasEntry = false;
    let entryType = '';
    let quality: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

    if (isPullbackToEma && isReversalCandle) {
      hasEntry = true;
      entryType = 'PULLBACK_REVERSAL';
      quality = pullbackDepth <= 0.5 ? 'HIGH' : 'MEDIUM';
    } else if (isBreakoutReentry) {
      hasEntry = true;
      entryType = 'BREAKOUT_REENTRY';
      quality = 'MEDIUM';
    }
    // Removed: LOW quality pullback without reversal - too many false entries

    return { hasEntry, entryType, pullbackDepth, quality };
  }

  /**
   * Calculate signal confidence
   */
  private calculateConfidence(
    trendAnalysis: ReturnType<typeof this.analyzeTrend>,
    entryAnalysis: ReturnType<typeof this.analyzeEntry>,
  ): number {
    let confidence = 50; // Base confidence

    // Trend strength contribution (0-25)
    confidence += trendAnalysis.strength * 25;

    // ADX contribution (0-15)
    if (trendAnalysis.adx >= 30) confidence += 15;
    else if (trendAnalysis.adx >= 25) confidence += 10;
    else if (trendAnalysis.adx >= 20) confidence += 5;

    // Entry quality contribution (0-10)
    if (entryAnalysis.quality === 'HIGH') confidence += 10;
    else if (entryAnalysis.quality === 'MEDIUM') confidence += 5;

    return Math.min(Math.round(confidence), 100);
  }
}
