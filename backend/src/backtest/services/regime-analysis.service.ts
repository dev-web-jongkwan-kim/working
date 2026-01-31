/**
 * Regime Analysis Service
 *
 * Analyzes strategy performance across different market regimes:
 * - Trend direction (bull, bear, sideways)
 * - Volatility level (low, normal, high, extreme)
 * - Market structure (trending, ranging, choppy)
 *
 * Purpose: Identify regime dependencies and blind spots
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ExtendedMetrics,
  MetricsCalculatorService,
} from './metrics-calculator.service';

export enum TrendRegime {
  STRONG_BULL = 'STRONG_BULL', // >20% annualized return
  BULL = 'BULL', // 5-20%
  SIDEWAYS = 'SIDEWAYS', // -5% to 5%
  BEAR = 'BEAR', // -20% to -5%
  STRONG_BEAR = 'STRONG_BEAR', // <-20%
}

export enum VolatilityRegime {
  LOW = 'LOW', // <10% annualized
  NORMAL = 'NORMAL', // 10-25%
  HIGH = 'HIGH', // 25-50%
  EXTREME = 'EXTREME', // >50%
}

export enum MarketStructure {
  TRENDING = 'TRENDING', // ADX > 25
  RANGING = 'RANGING', // ADX < 20, clear S/R
  CHOPPY = 'CHOPPY', // Low ADX, no clear structure
}

export interface RegimePeriod {
  startDate: Date;
  endDate: Date;
  trendRegime: TrendRegime;
  volatilityRegime: VolatilityRegime;
  marketStructure: MarketStructure;

  /** Market stats during period */
  stats: {
    returnPercent: number;
    volatilityPercent: number;
    adx: number;
    avgTrueRange: number;
  };
}

export interface RegimeTradeStats {
  regime: string;
  trades: number;
  winRate: number;
  avgPnL: number;
  totalPnL: number;
  avgHoldingHours: number;
  sharpeRatio: number;
  profitFactor: number;
  maxDrawdown: number;
}

export interface RegimePerformance {
  trendRegime: TrendRegime;
  volatilityRegime: VolatilityRegime;
  marketStructure: MarketStructure;
  stats: RegimeTradeStats;
  tradesInRegime: number;
  percentOfTotal: number;
}

export interface RegimeAnalysisResult {
  /** All identified regimes */
  regimes: RegimePeriod[];

  /** Performance by trend regime */
  byTrend: Record<TrendRegime, RegimeTradeStats>;

  /** Performance by volatility regime */
  byVolatility: Record<VolatilityRegime, RegimeTradeStats>;

  /** Performance by market structure */
  byStructure: Record<MarketStructure, RegimeTradeStats>;

  /** Cross-regime analysis (trend x volatility) */
  crossAnalysis: RegimePerformance[];

  /** Regime transition analysis */
  transitions: {
    from: string;
    to: string;
    count: number;
    avgPnLAfterTransition: number;
  }[];

  /** Regime exposure analysis */
  exposure: {
    mostExposed: string;
    leastExposed: string;
    missingRegimes: string[];
    regimeDiversity: number; // 0-100
  };

  /** Strategy character assessment */
  strategyCharacter: {
    /** Is this a trend-following strategy? */
    isTrendFollowing: boolean;

    /** Is this a mean-reversion strategy? */
    isMeanReversion: boolean;

    /** Preferred regime */
    preferredRegime: string;

    /** Worst regime */
    worstRegime: string;

    /** Regime sensitivity score (lower is better) */
    regimeSensitivity: number;
  };

  /** Recommendations */
  recommendations: string[];
}

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeData {
  entryTime: number;
  exitTime: number;
  pnl: number;
  direction: 'LONG' | 'SHORT';
}

@Injectable()
export class RegimeAnalysisService {
  private readonly logger = new Logger(RegimeAnalysisService.name);

  constructor(private readonly metricsCalculator: MetricsCalculatorService) {}

  /**
   * Analyze strategy performance across regimes
   */
  async analyzeRegimes(
    candles: CandleData[],
    trades: TradeData[],
    windowSizeDays: number = 20,
  ): Promise<RegimeAnalysisResult> {
    this.logger.log(
      `Analyzing regimes: ${candles.length} candles, ${trades.length} trades`,
    );

    // Identify regime periods
    const regimes = this.identifyRegimes(candles, windowSizeDays);

    // Classify trades into regimes
    const tradesByRegime = this.classifyTradesByRegime(trades, regimes);

    // Calculate performance by each regime dimension
    const byTrend = this.calculateByDimension(
      tradesByRegime,
      'trendRegime',
      Object.values(TrendRegime),
    );
    const byVolatility = this.calculateByDimension(
      tradesByRegime,
      'volatilityRegime',
      Object.values(VolatilityRegime),
    );
    const byStructure = this.calculateByDimension(
      tradesByRegime,
      'marketStructure',
      Object.values(MarketStructure),
    );

    // Cross-regime analysis
    const crossAnalysis = this.calculateCrossAnalysis(tradesByRegime, trades.length);

    // Transition analysis
    const transitions = this.analyzeTransitions(regimes, tradesByRegime);

    // Exposure analysis
    const exposure = this.analyzeExposure(tradesByRegime, trades.length);

    // Strategy character
    const strategyCharacter = this.assessStrategyCharacter(
      byTrend,
      byVolatility,
      byStructure,
    );

    // Generate recommendations
    const recommendations = this.generateRecommendations(
      byTrend,
      byVolatility,
      byStructure,
      exposure,
      strategyCharacter,
    );

    return {
      regimes,
      byTrend,
      byVolatility,
      byStructure,
      crossAnalysis,
      transitions,
      exposure,
      strategyCharacter,
      recommendations,
    };
  }

  /**
   * Identify regime periods from candle data
   */
  private identifyRegimes(
    candles: CandleData[],
    windowSizeDays: number,
  ): RegimePeriod[] {
    const regimes: RegimePeriod[] = [];
    const msPerDay = 24 * 60 * 60 * 1000;
    const windowMs = windowSizeDays * msPerDay;

    // Calculate rolling metrics
    const atrPeriod = 14;
    const adxPeriod = 14;

    for (let i = 0; i < candles.length; i++) {
      const windowStart = candles[i].timestamp;
      const windowEnd = windowStart + windowMs;

      // Find candles in window
      const windowCandles = candles.filter(
        (c) => c.timestamp >= windowStart && c.timestamp < windowEnd,
      );

      if (windowCandles.length < 5) continue;

      // Calculate metrics
      const returns = this.calculateReturns(windowCandles);
      const annualizedReturn = returns * (365 / windowSizeDays);

      const volatility = this.calculateVolatility(windowCandles);
      const annualizedVol = volatility * Math.sqrt(365 / windowSizeDays);

      const atr = this.calculateATR(windowCandles, atrPeriod);
      const adx = this.calculateADX(windowCandles, adxPeriod);

      // Classify regimes
      const trendRegime = this.classifyTrend(annualizedReturn);
      const volatilityRegime = this.classifyVolatility(annualizedVol);
      const marketStructure = this.classifyStructure(adx);

      // Only add if different from last regime or first
      const lastRegime = regimes[regimes.length - 1];
      if (
        !lastRegime ||
        lastRegime.trendRegime !== trendRegime ||
        lastRegime.volatilityRegime !== volatilityRegime ||
        lastRegime.marketStructure !== marketStructure
      ) {
        // Close previous regime
        if (lastRegime) {
          lastRegime.endDate = new Date(windowStart);
        }

        regimes.push({
          startDate: new Date(windowStart),
          endDate: new Date(windowEnd),
          trendRegime,
          volatilityRegime,
          marketStructure,
          stats: {
            returnPercent: annualizedReturn * 100,
            volatilityPercent: annualizedVol * 100,
            adx,
            avgTrueRange: atr,
          },
        });
      }

      // Skip ahead to avoid overlapping windows
      i += Math.floor(windowSizeDays / 2);
    }

    return regimes;
  }

  /**
   * Classify trades into their respective regimes
   */
  private classifyTradesByRegime(
    trades: TradeData[],
    regimes: RegimePeriod[],
  ): Map<string, TradeData[]> {
    const map = new Map<string, TradeData[]>();

    for (const trade of trades) {
      // Find regime at trade entry
      const regime = regimes.find(
        (r) =>
          trade.entryTime >= r.startDate.getTime() &&
          trade.entryTime < r.endDate.getTime(),
      );

      if (regime) {
        const key = `${regime.trendRegime}|${regime.volatilityRegime}|${regime.marketStructure}`;
        if (!map.has(key)) {
          map.set(key, []);
        }
        map.get(key)!.push(trade);
      }
    }

    return map;
  }

  /**
   * Calculate performance by a single dimension
   */
  private calculateByDimension<T extends string>(
    tradesByRegime: Map<string, TradeData[]>,
    dimension: 'trendRegime' | 'volatilityRegime' | 'marketStructure',
    values: T[],
  ): Record<T, RegimeTradeStats> {
    const result = {} as Record<T, RegimeTradeStats>;
    const dimIndex =
      dimension === 'trendRegime' ? 0 : dimension === 'volatilityRegime' ? 1 : 2;

    for (const value of values) {
      const tradesInDimension: TradeData[] = [];

      for (const [key, trades] of tradesByRegime.entries()) {
        const parts = key.split('|');
        if (parts[dimIndex] === value) {
          tradesInDimension.push(...trades);
        }
      }

      result[value] = this.calculateStats(value, tradesInDimension);
    }

    return result;
  }

  /**
   * Calculate stats for a set of trades
   */
  private calculateStats(regime: string, trades: TradeData[]): RegimeTradeStats {
    if (trades.length === 0) {
      return {
        regime,
        trades: 0,
        winRate: 0,
        avgPnL: 0,
        totalPnL: 0,
        avgHoldingHours: 0,
        sharpeRatio: 0,
        profitFactor: 0,
        maxDrawdown: 0,
      };
    }

    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl <= 0);

    const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnL = totalPnL / trades.length;

    const avgHoldingMs =
      trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0) /
      trades.length;
    const avgHoldingHours = avgHoldingMs / (1000 * 60 * 60);

    // Calculate Sharpe (simplified)
    const returns = trades.map((t) => t.pnl);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdReturn = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
        returns.length,
    );
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    // Profit factor
    const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Max drawdown
    const equityCurve = this.buildEquityCurve(trades);
    const maxDrawdown = this.calculateMaxDrawdown(equityCurve);

    return {
      regime,
      trades: trades.length,
      winRate: (wins.length / trades.length) * 100,
      avgPnL,
      totalPnL,
      avgHoldingHours,
      sharpeRatio,
      profitFactor,
      maxDrawdown: maxDrawdown * 100,
    };
  }

  /**
   * Cross-regime analysis
   */
  private calculateCrossAnalysis(
    tradesByRegime: Map<string, TradeData[]>,
    totalTrades: number,
  ): RegimePerformance[] {
    const results: RegimePerformance[] = [];

    for (const [key, trades] of tradesByRegime.entries()) {
      const [trend, vol, structure] = key.split('|') as [
        TrendRegime,
        VolatilityRegime,
        MarketStructure,
      ];

      results.push({
        trendRegime: trend,
        volatilityRegime: vol,
        marketStructure: structure,
        stats: this.calculateStats(key, trades),
        tradesInRegime: trades.length,
        percentOfTotal: (trades.length / totalTrades) * 100,
      });
    }

    // Sort by PnL
    return results.sort((a, b) => b.stats.totalPnL - a.stats.totalPnL);
  }

  /**
   * Analyze regime transitions
   */
  private analyzeTransitions(
    regimes: RegimePeriod[],
    tradesByRegime: Map<string, TradeData[]>,
  ): RegimeAnalysisResult['transitions'] {
    const transitions: Map<
      string,
      { count: number; pnlSum: number; tradeCount: number }
    > = new Map();

    for (let i = 1; i < regimes.length; i++) {
      const from = regimes[i - 1];
      const to = regimes[i];

      const fromKey = `${from.trendRegime}|${from.volatilityRegime}`;
      const toKey = `${to.trendRegime}|${to.volatilityRegime}`;
      const transitionKey = `${fromKey}->${toKey}`;

      if (!transitions.has(transitionKey)) {
        transitions.set(transitionKey, { count: 0, pnlSum: 0, tradeCount: 0 });
      }

      const data = transitions.get(transitionKey)!;
      data.count++;

      // Find trades right after transition
      const tradesAfter = Array.from(tradesByRegime.values())
        .flat()
        .filter(
          (t) =>
            t.entryTime >= to.startDate.getTime() &&
            t.entryTime < to.startDate.getTime() + 7 * 24 * 60 * 60 * 1000,
        );

      data.pnlSum += tradesAfter.reduce((sum, t) => sum + t.pnl, 0);
      data.tradeCount += tradesAfter.length;
    }

    return Array.from(transitions.entries())
      .map(([key, data]) => {
        const [from, to] = key.split('->');
        return {
          from,
          to,
          count: data.count,
          avgPnLAfterTransition:
            data.tradeCount > 0 ? data.pnlSum / data.tradeCount : 0,
        };
      })
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Analyze regime exposure
   */
  private analyzeExposure(
    tradesByRegime: Map<string, TradeData[]>,
    totalTrades: number,
  ): RegimeAnalysisResult['exposure'] {
    const exposures: { regime: string; count: number }[] = [];
    const allPossibleRegimes = new Set<string>();

    // Generate all possible regimes
    for (const trend of Object.values(TrendRegime)) {
      for (const vol of Object.values(VolatilityRegime)) {
        for (const struct of Object.values(MarketStructure)) {
          allPossibleRegimes.add(`${trend}|${vol}|${struct}`);
        }
      }
    }

    // Calculate exposure
    for (const [key, trades] of tradesByRegime.entries()) {
      exposures.push({ regime: key, count: trades.length });
    }

    exposures.sort((a, b) => b.count - a.count);

    // Find missing regimes
    const observedRegimes = new Set(tradesByRegime.keys());
    const missingRegimes = Array.from(allPossibleRegimes).filter(
      (r) => !observedRegimes.has(r),
    );

    // Calculate diversity (entropy-based)
    const proportions = exposures.map((e) => e.count / totalTrades);
    const entropy = -proportions
      .filter((p) => p > 0)
      .reduce((sum, p) => sum + p * Math.log2(p), 0);
    const maxEntropy = Math.log2(allPossibleRegimes.size);
    const diversity = (entropy / maxEntropy) * 100;

    return {
      mostExposed: exposures[0]?.regime || 'N/A',
      leastExposed: exposures[exposures.length - 1]?.regime || 'N/A',
      missingRegimes,
      regimeDiversity: diversity,
    };
  }

  /**
   * Assess strategy character
   */
  private assessStrategyCharacter(
    byTrend: Record<TrendRegime, RegimeTradeStats>,
    byVolatility: Record<VolatilityRegime, RegimeTradeStats>,
    byStructure: Record<MarketStructure, RegimeTradeStats>,
  ): RegimeAnalysisResult['strategyCharacter'] {
    // Trend following: Better in strong trends
    const trendingPnL =
      (byTrend[TrendRegime.STRONG_BULL]?.totalPnL || 0) +
      (byTrend[TrendRegime.STRONG_BEAR]?.totalPnL || 0);
    const sidewaysPnL = byTrend[TrendRegime.SIDEWAYS]?.totalPnL || 0;

    const isTrendFollowing = trendingPnL > sidewaysPnL * 2;

    // Mean reversion: Better in ranging/sideways
    const rangingPnL = byStructure[MarketStructure.RANGING]?.totalPnL || 0;
    const trendingStructurePnL = byStructure[MarketStructure.TRENDING]?.totalPnL || 0;

    const isMeanReversion = rangingPnL > trendingStructurePnL * 2;

    // Find best and worst regimes
    const allRegimes = [
      ...Object.entries(byTrend),
      ...Object.entries(byVolatility),
      ...Object.entries(byStructure),
    ].filter(([_, stats]) => stats.trades > 0);

    allRegimes.sort((a, b) => b[1].sharpeRatio - a[1].sharpeRatio);
    const preferredRegime = allRegimes[0]?.[0] || 'N/A';
    const worstRegime = allRegimes[allRegimes.length - 1]?.[0] || 'N/A';

    // Regime sensitivity (variance in performance across regimes)
    const sharpes = allRegimes.map(([_, stats]) => stats.sharpeRatio);
    const avgSharpe = sharpes.reduce((a, b) => a + b, 0) / sharpes.length;
    const variance =
      sharpes.reduce((sum, s) => sum + Math.pow(s - avgSharpe, 2), 0) /
      sharpes.length;
    const regimeSensitivity = Math.sqrt(variance) * 100;

    return {
      isTrendFollowing,
      isMeanReversion,
      preferredRegime,
      worstRegime,
      regimeSensitivity,
    };
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    byTrend: Record<TrendRegime, RegimeTradeStats>,
    byVolatility: Record<VolatilityRegime, RegimeTradeStats>,
    byStructure: Record<MarketStructure, RegimeTradeStats>,
    exposure: RegimeAnalysisResult['exposure'],
    character: RegimeAnalysisResult['strategyCharacter'],
  ): string[] {
    const recommendations: string[] = [];

    // Regime sensitivity
    if (character.regimeSensitivity > 50) {
      recommendations.push(
        `WARNING: High regime sensitivity (${character.regimeSensitivity.toFixed(0)}%). Strategy performance varies significantly across market conditions.`,
      );
    }

    // Trend following in sideways market
    if (
      character.isTrendFollowing &&
      (byTrend[TrendRegime.SIDEWAYS]?.totalPnL || 0) < 0
    ) {
      recommendations.push(
        'CAUTION: Trend-following strategy loses money in sideways markets. Consider adding ranging detection filter.',
      );
    }

    // Mean reversion in trending market
    if (
      character.isMeanReversion &&
      (byStructure[MarketStructure.TRENDING]?.totalPnL || 0) < 0
    ) {
      recommendations.push(
        'CAUTION: Mean-reversion strategy struggles in trending markets. Consider adding trend filter.',
      );
    }

    // Volatility exposure
    if ((byVolatility[VolatilityRegime.EXTREME]?.trades || 0) < 5) {
      recommendations.push(
        'NOTE: Limited exposure to extreme volatility regimes. Performance during market stress is uncertain.',
      );
    }

    if ((byVolatility[VolatilityRegime.EXTREME]?.totalPnL || 0) < 0) {
      recommendations.push(
        'WARNING: Strategy loses money in extreme volatility. Consider reducing position size or pausing during vol spikes.',
      );
    }

    // Exposure diversity
    if (exposure.regimeDiversity < 30) {
      recommendations.push(
        `NOTE: Low regime diversity (${exposure.regimeDiversity.toFixed(0)}%). Results may not generalize to all market conditions.`,
      );
    }

    if (exposure.missingRegimes.length > 10) {
      recommendations.push(
        `NOTE: ${exposure.missingRegimes.length} regime combinations not observed. Consider backtesting over longer period.`,
      );
    }

    // Positive signals
    if (character.regimeSensitivity < 30) {
      recommendations.push(
        `POSITIVE: Low regime sensitivity (${character.regimeSensitivity.toFixed(0)}%). Strategy shows consistent performance across conditions.`,
      );
    }

    // Best regime
    recommendations.push(
      `INFO: Strategy performs best in ${character.preferredRegime} regime. Worst in ${character.worstRegime}.`,
    );

    return recommendations;
  }

  // Helper methods

  private calculateReturns(candles: CandleData[]): number {
    if (candles.length < 2) return 0;
    const first = candles[0].close;
    const last = candles[candles.length - 1].close;
    return (last - first) / first;
  }

  private calculateVolatility(candles: CandleData[]): number {
    if (candles.length < 2) return 0;

    const returns: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push(
        (candles[i].close - candles[i - 1].close) / candles[i - 1].close,
      );
    }

    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) /
      returns.length;

    return Math.sqrt(variance);
  }

  private calculateATR(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) return 0;

    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      );
      trs.push(tr);
    }

    // Simple moving average of last 'period' TRs
    const recentTrs = trs.slice(-period);
    return recentTrs.reduce((a, b) => a + b, 0) / recentTrs.length;
  }

  private calculateADX(candles: CandleData[], period: number): number {
    if (candles.length < period * 2) return 25; // Default to neutral

    // Simplified ADX calculation
    const dxValues: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;

      const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;

      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      );

      if (tr > 0) {
        const plusDI = plusDM / tr;
        const minusDI = minusDM / tr;
        const sum = plusDI + minusDI;
        const dx = sum > 0 ? Math.abs(plusDI - minusDI) / sum : 0;
        dxValues.push(dx * 100);
      }
    }

    // Average DX = ADX
    const recentDx = dxValues.slice(-period);
    return recentDx.reduce((a, b) => a + b, 0) / recentDx.length;
  }

  private classifyTrend(annualizedReturn: number): TrendRegime {
    if (annualizedReturn > 0.2) return TrendRegime.STRONG_BULL;
    if (annualizedReturn > 0.05) return TrendRegime.BULL;
    if (annualizedReturn > -0.05) return TrendRegime.SIDEWAYS;
    if (annualizedReturn > -0.2) return TrendRegime.BEAR;
    return TrendRegime.STRONG_BEAR;
  }

  private classifyVolatility(annualizedVol: number): VolatilityRegime {
    if (annualizedVol < 0.1) return VolatilityRegime.LOW;
    if (annualizedVol < 0.25) return VolatilityRegime.NORMAL;
    if (annualizedVol < 0.5) return VolatilityRegime.HIGH;
    return VolatilityRegime.EXTREME;
  }

  private classifyStructure(adx: number): MarketStructure {
    if (adx > 25) return MarketStructure.TRENDING;
    if (adx > 15) return MarketStructure.RANGING;
    return MarketStructure.CHOPPY;
  }

  private buildEquityCurve(trades: TradeData[]): number[] {
    const curve: number[] = [10000];
    let equity = 10000;

    for (const trade of trades) {
      equity += trade.pnl;
      curve.push(equity);
    }

    return curve;
  }

  private calculateMaxDrawdown(equityCurve: number[]): number {
    let maxDD = 0;
    let peak = equityCurve[0];

    for (const value of equityCurve) {
      if (value > peak) peak = value;
      const dd = (peak - value) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    return maxDD;
  }
}
