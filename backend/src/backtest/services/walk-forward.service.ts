/**
 * Walk-Forward Validation Service
 *
 * Implements rolling train/test window validation to prevent overfitting
 * and measure true out-of-sample performance.
 *
 * Key concepts:
 * - Rolling windows: Move forward in time, always train on past, test on future
 * - Out-of-sample validation: Never use test data for optimization
 * - Anchored vs Rolling: Anchored grows training set, rolling keeps fixed size
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ExtendedMetrics,
  MetricsCalculatorService,
  TradeResult,
} from './metrics-calculator.service';

export interface WalkForwardConfig {
  /** Training window size in days */
  trainWindowDays: number;

  /** Test window size in days */
  testWindowDays: number;

  /** Step size for rolling forward (days) */
  stepDays: number;

  /** Minimum number of trades required in test window */
  minTestTrades: number;

  /** Use anchored walk-forward (growing train window) vs rolling */
  useAnchored: boolean;

  /** Number of optimization iterations per window */
  optimizationIterations: number;

  /** Parameter ranges for optimization */
  parameterRanges?: ParameterRange[];
}

export interface ParameterRange {
  name: string;
  min: number;
  max: number;
  step: number;
}

export interface WindowResult {
  /** Window index */
  windowIndex: number;

  /** Training period start */
  trainStart: Date;

  /** Training period end */
  trainEnd: Date;

  /** Test period start */
  testStart: Date;

  /** Test period end */
  testEnd: Date;

  /** Best parameters found in training */
  optimizedParams: Record<string, number>;

  /** Training metrics with best params */
  trainMetrics: ExtendedMetrics;

  /** Out-of-sample test metrics */
  testMetrics: ExtendedMetrics;

  /** Performance degradation from train to test */
  degradation: {
    sharpeRatio: number;
    winRate: number;
    profitFactor: number;
    maxDrawdown: number;
  };

  /** Number of trades in test period */
  testTrades: number;
}

export interface WalkForwardResult {
  /** Configuration used */
  config: WalkForwardConfig;

  /** Results for each window */
  windows: WindowResult[];

  /** Aggregated out-of-sample metrics */
  aggregatedOOS: {
    totalTrades: number;
    avgSharpeRatio: number;
    avgWinRate: number;
    avgProfitFactor: number;
    avgMaxDrawdown: number;
    combinedPnL: number;
    combinedEquityCurve: number[];
  };

  /** Walk-forward efficiency (OOS/IS performance ratio) */
  efficiency: {
    sharpeEfficiency: number;
    winRateEfficiency: number;
    profitFactorEfficiency: number;
  };

  /** Statistical tests */
  statistics: {
    /** Is OOS performance statistically significant? */
    oosSignificant: boolean;

    /** P-value from t-test of IS vs OOS */
    pValue: number;

    /** Is there evidence of overfitting? */
    overfittingDetected: boolean;

    /** Consistency score (% of windows profitable OOS) */
    consistencyScore: number;
  };

  /** Recommendations based on results */
  recommendations: string[];
}

export interface BacktestRunner {
  runBacktest(
    startDate: Date,
    endDate: Date,
    params: Record<string, number>,
  ): Promise<{
    trades: TradeResult[];
    equityCurve: number[];
  }>;
}

const DEFAULT_CONFIG: WalkForwardConfig = {
  trainWindowDays: 180, // 6 months training
  testWindowDays: 30, // 1 month test
  stepDays: 30, // Roll forward 1 month
  minTestTrades: 10,
  useAnchored: false,
  optimizationIterations: 100,
};

@Injectable()
export class WalkForwardService {
  private readonly logger = new Logger(WalkForwardService.name);

  constructor(private readonly metricsCalculator: MetricsCalculatorService) {}

  /**
   * Run walk-forward validation
   */
  async runWalkForward(
    runner: BacktestRunner,
    dataStartDate: Date,
    dataEndDate: Date,
    config: Partial<WalkForwardConfig> = {},
    baseParams: Record<string, number> = {},
  ): Promise<WalkForwardResult> {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    this.logger.log(
      `Starting walk-forward validation: ${fullConfig.trainWindowDays}d train, ${fullConfig.testWindowDays}d test`,
    );

    const windows: WindowResult[] = [];

    // Calculate windows
    const windowDefs = this.calculateWindows(
      dataStartDate,
      dataEndDate,
      fullConfig,
    );
    this.logger.log(`Generated ${windowDefs.length} walk-forward windows`);

    // Process each window
    for (let i = 0; i < windowDefs.length; i++) {
      const windowDef = windowDefs[i];

      this.logger.log(
        `Processing window ${i + 1}/${windowDefs.length}: ` +
          `Train ${windowDef.trainStart.toISOString().slice(0, 10)} to ${windowDef.trainEnd.toISOString().slice(0, 10)}, ` +
          `Test ${windowDef.testStart.toISOString().slice(0, 10)} to ${windowDef.testEnd.toISOString().slice(0, 10)}`,
      );

      // Optimize on training data
      const optimizedParams = await this.optimizeParameters(
        runner,
        windowDef.trainStart,
        windowDef.trainEnd,
        baseParams,
        fullConfig,
      );

      // Run training with optimized params
      const trainResult = await runner.runBacktest(
        windowDef.trainStart,
        windowDef.trainEnd,
        optimizedParams,
      );
      const trainMetrics = this.metricsCalculator.calculateExtendedMetrics(
        trainResult.trades,
        10000, // Initial balance
      );

      // Run out-of-sample test
      const testResult = await runner.runBacktest(
        windowDef.testStart,
        windowDef.testEnd,
        optimizedParams,
      );
      const testMetrics = this.metricsCalculator.calculateExtendedMetrics(
        testResult.trades,
        10000, // Initial balance
      );

      // Calculate degradation
      const degradation = this.calculateDegradation(trainMetrics, testMetrics);

      windows.push({
        windowIndex: i,
        trainStart: windowDef.trainStart,
        trainEnd: windowDef.trainEnd,
        testStart: windowDef.testStart,
        testEnd: windowDef.testEnd,
        optimizedParams,
        trainMetrics,
        testMetrics,
        degradation,
        testTrades: testResult.trades.length,
      });
    }

    // Calculate aggregated results
    const aggregatedOOS = this.aggregateOOSResults(windows);
    const efficiency = this.calculateEfficiency(windows);
    const statistics = this.calculateStatistics(windows);
    const recommendations = this.generateRecommendations(
      windows,
      efficiency,
      statistics,
    );

    return {
      config: fullConfig,
      windows,
      aggregatedOOS,
      efficiency,
      statistics,
      recommendations,
    };
  }

  /**
   * Calculate window definitions
   */
  private calculateWindows(
    dataStart: Date,
    dataEnd: Date,
    config: WalkForwardConfig,
  ): Array<{
    trainStart: Date;
    trainEnd: Date;
    testStart: Date;
    testEnd: Date;
  }> {
    const windows: Array<{
      trainStart: Date;
      trainEnd: Date;
      testStart: Date;
      testEnd: Date;
    }> = [];

    const trainMs = config.trainWindowDays * 24 * 60 * 60 * 1000;
    const testMs = config.testWindowDays * 24 * 60 * 60 * 1000;
    const stepMs = config.stepDays * 24 * 60 * 60 * 1000;

    let anchorStart = dataStart.getTime();
    let windowStart = dataStart.getTime();

    while (windowStart + trainMs + testMs <= dataEnd.getTime()) {
      const trainStart = config.useAnchored
        ? new Date(anchorStart)
        : new Date(windowStart);
      const trainEnd = new Date(windowStart + trainMs);
      const testStart = new Date(windowStart + trainMs);
      const testEnd = new Date(windowStart + trainMs + testMs);

      windows.push({ trainStart, trainEnd, testStart, testEnd });

      windowStart += stepMs;
    }

    return windows;
  }

  /**
   * Optimize parameters on training data
   */
  private async optimizeParameters(
    runner: BacktestRunner,
    trainStart: Date,
    trainEnd: Date,
    baseParams: Record<string, number>,
    config: WalkForwardConfig,
  ): Promise<Record<string, number>> {
    if (
      !config.parameterRanges ||
      config.parameterRanges.length === 0
    ) {
      return baseParams;
    }

    let bestParams = { ...baseParams };
    let bestScore = -Infinity;

    // Grid search with random sampling for larger spaces
    const paramCombinations = this.generateParameterCombinations(
      config.parameterRanges,
      config.optimizationIterations,
    );

    for (const params of paramCombinations) {
      const mergedParams = { ...baseParams, ...params };
      const result = await runner.runBacktest(trainStart, trainEnd, mergedParams);

      if (result.trades.length < 5) continue;

      const metrics = this.metricsCalculator.calculateExtendedMetrics(
        result.trades,
        10000, // Initial balance
      );

      // Optimization objective: Risk-adjusted return with stability
      const score = this.calculateOptimizationScore(metrics);

      if (score > bestScore) {
        bestScore = score;
        bestParams = mergedParams;
      }
    }

    return bestParams;
  }

  /**
   * Generate parameter combinations for optimization
   */
  private generateParameterCombinations(
    ranges: ParameterRange[],
    maxIterations: number,
  ): Array<Record<string, number>> {
    const combinations: Array<Record<string, number>> = [];

    // Calculate total grid size
    let totalCombinations = 1;
    for (const range of ranges) {
      const steps = Math.ceil((range.max - range.min) / range.step) + 1;
      totalCombinations *= steps;
    }

    if (totalCombinations <= maxIterations) {
      // Full grid search
      this.generateGridRecursive(ranges, 0, {}, combinations);
    } else {
      // Random sampling
      for (let i = 0; i < maxIterations; i++) {
        const params: Record<string, number> = {};
        for (const range of ranges) {
          const steps = Math.ceil((range.max - range.min) / range.step);
          const randomStep = Math.floor(Math.random() * (steps + 1));
          params[range.name] = range.min + randomStep * range.step;
        }
        combinations.push(params);
      }
    }

    return combinations;
  }

  /**
   * Recursive grid generation
   */
  private generateGridRecursive(
    ranges: ParameterRange[],
    index: number,
    current: Record<string, number>,
    results: Array<Record<string, number>>,
  ): void {
    if (index === ranges.length) {
      results.push({ ...current });
      return;
    }

    const range = ranges[index];
    for (let value = range.min; value <= range.max; value += range.step) {
      current[range.name] = value;
      this.generateGridRecursive(ranges, index + 1, current, results);
    }
  }

  /**
   * Calculate optimization score (multi-objective)
   */
  private calculateOptimizationScore(metrics: ExtendedMetrics): number {
    // Prioritize:
    // 1. Sharpe ratio (risk-adjusted)
    // 2. Profit factor (edge consistency)
    // 3. Max drawdown (risk control)
    // 4. Win rate stability

    const sharpeScore = Math.min(metrics.risk.sharpeRatio, 3) / 3; // Cap at 3
    const pfScore = Math.min(metrics.basic.profitFactor, 3) / 3;
    const ddScore = Math.max(0, 1 - metrics.drawdown.maxDrawdownPercent / 30); // 30% = 0
    const wrScore = metrics.basic.winRate / 100;

    // Weighted combination
    return (
      sharpeScore * 0.4 +
      pfScore * 0.3 +
      ddScore * 0.2 +
      wrScore * 0.1
    );
  }

  /**
   * Calculate performance degradation from train to test
   */
  private calculateDegradation(
    train: ExtendedMetrics,
    test: ExtendedMetrics,
  ): WindowResult['degradation'] {
    const safeDivide = (a: number, b: number) =>
      b === 0 ? 0 : (a - b) / Math.abs(b);

    return {
      sharpeRatio: safeDivide(
        test.risk.sharpeRatio,
        train.risk.sharpeRatio,
      ),
      winRate: safeDivide(test.basic.winRate, train.basic.winRate),
      profitFactor: safeDivide(
        test.basic.profitFactor,
        train.basic.profitFactor,
      ),
      maxDrawdown: safeDivide(
        test.drawdown.maxDrawdownPercent,
        train.drawdown.maxDrawdownPercent,
      ),
    };
  }

  /**
   * Aggregate out-of-sample results across all windows
   */
  private aggregateOOSResults(
    windows: WindowResult[],
  ): WalkForwardResult['aggregatedOOS'] {
    const validWindows = windows.filter((w) => w.testTrades > 0);

    const totalTrades = validWindows.reduce((sum, w) => sum + w.testTrades, 0);
    const avgSharpeRatio =
      validWindows.reduce((sum, w) => sum + w.testMetrics.risk.sharpeRatio, 0) /
      validWindows.length;
    const avgWinRate =
      validWindows.reduce((sum, w) => sum + w.testMetrics.basic.winRate, 0) /
      validWindows.length;
    const avgProfitFactor =
      validWindows.reduce(
        (sum, w) => sum + w.testMetrics.basic.profitFactor,
        0,
      ) / validWindows.length;
    const avgMaxDrawdown =
      validWindows.reduce(
        (sum, w) => sum + w.testMetrics.drawdown.maxDrawdownPercent,
        0,
      ) / validWindows.length;
    const combinedPnL = validWindows.reduce(
      (sum, w) => sum + w.testMetrics.basic.totalPnlUsd,
      0,
    );

    // Combine equity curves sequentially
    const combinedEquityCurve: number[] = [10000]; // Start with $10k
    let currentEquity = 10000;
    for (const window of validWindows) {
      // Apply test period return to current equity
      const returnPct = window.testMetrics.basic.totalPnlUsd / 10000;
      currentEquity *= 1 + returnPct;
      combinedEquityCurve.push(currentEquity);
    }

    return {
      totalTrades,
      avgSharpeRatio,
      avgWinRate,
      avgProfitFactor,
      avgMaxDrawdown,
      combinedPnL,
      combinedEquityCurve,
    };
  }

  /**
   * Calculate walk-forward efficiency
   */
  private calculateEfficiency(
    windows: WindowResult[],
  ): WalkForwardResult['efficiency'] {
    const validWindows = windows.filter(
      (w) => w.testTrades > 0 && w.trainMetrics.basic.totalTrades > 0,
    );

    const avgTrainSharpe =
      validWindows.reduce(
        (sum, w) => sum + w.trainMetrics.risk.sharpeRatio,
        0,
      ) / validWindows.length;
    const avgTestSharpe =
      validWindows.reduce((sum, w) => sum + w.testMetrics.risk.sharpeRatio, 0) /
      validWindows.length;

    const avgTrainWinRate =
      validWindows.reduce((sum, w) => sum + w.trainMetrics.basic.winRate, 0) /
      validWindows.length;
    const avgTestWinRate =
      validWindows.reduce((sum, w) => sum + w.testMetrics.basic.winRate, 0) /
      validWindows.length;

    const avgTrainPF =
      validWindows.reduce(
        (sum, w) => sum + w.trainMetrics.basic.profitFactor,
        0,
      ) / validWindows.length;
    const avgTestPF =
      validWindows.reduce(
        (sum, w) => sum + w.testMetrics.basic.profitFactor,
        0,
      ) / validWindows.length;

    return {
      sharpeEfficiency:
        avgTrainSharpe > 0 ? avgTestSharpe / avgTrainSharpe : 0,
      winRateEfficiency:
        avgTrainWinRate > 0 ? avgTestWinRate / avgTrainWinRate : 0,
      profitFactorEfficiency: avgTrainPF > 0 ? avgTestPF / avgTrainPF : 0,
    };
  }

  /**
   * Calculate statistical significance
   */
  private calculateStatistics(
    windows: WindowResult[],
  ): WalkForwardResult['statistics'] {
    const validWindows = windows.filter((w) => w.testTrades > 0);

    // Collect IS and OOS Sharpe ratios
    const isSharpes = validWindows.map((w) => w.trainMetrics.risk.sharpeRatio);
    const oosSharpes = validWindows.map((w) => w.testMetrics.risk.sharpeRatio);

    // Simple t-test
    const { tStatistic, pValue } = this.pairedTTest(isSharpes, oosSharpes);

    // Consistency: % of windows where OOS is profitable
    const profitableWindows = validWindows.filter(
      (w) => w.testMetrics.basic.totalPnlUsd > 0,
    ).length;
    const consistencyScore = (profitableWindows / validWindows.length) * 100;

    // Overfitting detection: Large degradation + inconsistency
    const avgDegradation =
      validWindows.reduce((sum, w) => sum + w.degradation.sharpeRatio, 0) /
      validWindows.length;
    const overfittingDetected = avgDegradation < -0.5 && consistencyScore < 50;

    return {
      oosSignificant: pValue < 0.05,
      pValue,
      overfittingDetected,
      consistencyScore,
    };
  }

  /**
   * Paired t-test for IS vs OOS comparison
   */
  private pairedTTest(
    sample1: number[],
    sample2: number[],
  ): { tStatistic: number; pValue: number } {
    if (sample1.length !== sample2.length || sample1.length < 2) {
      return { tStatistic: 0, pValue: 1 };
    }

    const n = sample1.length;
    const differences = sample1.map((v, i) => v - sample2[i]);
    const meanDiff = differences.reduce((a, b) => a + b, 0) / n;
    const stdDiff = Math.sqrt(
      differences.reduce((sum, d) => sum + Math.pow(d - meanDiff, 2), 0) /
        (n - 1),
    );

    if (stdDiff === 0) {
      return { tStatistic: 0, pValue: 1 };
    }

    const tStatistic = meanDiff / (stdDiff / Math.sqrt(n));

    // Approximate p-value using normal distribution for large n
    // For small n, this is an approximation
    const pValue = 2 * (1 - this.normalCDF(Math.abs(tStatistic)));

    return { tStatistic, pValue };
  }

  /**
   * Approximate normal CDF
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y =
      1.0 -
      ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }

  /**
   * Generate recommendations based on results
   */
  private generateRecommendations(
    windows: WindowResult[],
    efficiency: WalkForwardResult['efficiency'],
    statistics: WalkForwardResult['statistics'],
  ): string[] {
    const recommendations: string[] = [];

    // Efficiency warnings
    if (efficiency.sharpeEfficiency < 0.5) {
      recommendations.push(
        'WARNING: Sharpe ratio efficiency <50% - significant overfitting likely. Consider reducing parameters or using regularization.',
      );
    } else if (efficiency.sharpeEfficiency < 0.7) {
      recommendations.push(
        'CAUTION: Sharpe ratio efficiency 50-70% - moderate overfitting detected. Review parameter sensitivity.',
      );
    }

    // Consistency warnings
    if (statistics.consistencyScore < 50) {
      recommendations.push(
        'WARNING: Less than 50% of windows profitable OOS - strategy may not be robust across market conditions.',
      );
    }

    // Overfitting detection
    if (statistics.overfittingDetected) {
      recommendations.push(
        'ALERT: Strong overfitting signals detected. Consider simplifying strategy, adding regularization, or using more data.',
      );
    }

    // Sample size warnings
    const validWindows = windows.filter((w) => w.testTrades > 0);
    if (validWindows.length < 5) {
      recommendations.push(
        'NOTE: Only ' +
          validWindows.length +
          ' valid test windows. Consider longer data period for more robust validation.',
      );
    }

    // Positive signals
    if (efficiency.sharpeEfficiency >= 0.7 && statistics.consistencyScore >= 60) {
      recommendations.push(
        'POSITIVE: Walk-forward efficiency >=70% and consistency >=60% - strategy shows reasonable robustness.',
      );
    }

    if (
      efficiency.sharpeEfficiency >= 0.8 &&
      statistics.consistencyScore >= 70
    ) {
      recommendations.push(
        'STRONG: Walk-forward results indicate good out-of-sample performance. Consider paper trading validation.',
      );
    }

    // Trade frequency
    const avgTradesPerWindow =
      validWindows.reduce((sum, w) => sum + w.testTrades, 0) /
      validWindows.length;
    if (avgTradesPerWindow < 10) {
      recommendations.push(
        'NOTE: Average ' +
          avgTradesPerWindow.toFixed(1) +
          ' trades per test window. Results may have high variance.',
      );
    }

    return recommendations;
  }
}
