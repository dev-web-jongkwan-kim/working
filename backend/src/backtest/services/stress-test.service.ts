/**
 * Stress Test Service
 *
 * Simulates adverse conditions to measure strategy robustness:
 * - Adverse execution: Widened spreads, increased slippage, partial fills
 * - Extreme market: Flash crashes, gaps, volatility spikes
 * - System failures: Missed signals, delayed execution, data gaps
 *
 * Purpose: Ensure strategy survives real-world stress scenarios
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ExecutionModelConfig,
  STRESS_EXECUTION_CONFIG,
} from '../models/execution-model';
import {
  ExtendedMetrics,
  MetricsCalculatorService,
  TradeResult,
} from './metrics-calculator.service';

export interface StressScenario {
  name: string;
  description: string;
  type: 'execution' | 'market' | 'system';

  /** Price modification function */
  priceModifier?: (
    price: number,
    timestamp: number,
    context: ScenarioContext,
  ) => number;

  /** Trade filter (return false to skip trade) */
  tradeFilter?: (trade: TradeInput, context: ScenarioContext) => boolean;

  /** Trade modifier (adjust entry/exit) */
  tradeModifier?: (trade: TradeInput, context: ScenarioContext) => TradeInput;

  /** Execution config overrides */
  executionOverrides?: Partial<ExecutionModelConfig>;

  /** Probability of scenario occurring (for Monte Carlo) */
  probability?: number;
}

export interface ScenarioContext {
  volatility: number; // Current ATR%
  dayOfWeek: number;
  hourOfDay: number;
  priceHistory: number[];
  tradeIndex: number;
  totalTrades: number;
}

export interface TradeInput {
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  direction: 'LONG' | 'SHORT';
  sizeUsd: number;
  pnl: number;
}

export interface StressTestResult {
  scenario: string;
  description: string;

  /** Original metrics (no stress) */
  baselineMetrics: ExtendedMetrics;

  /** Metrics under stress */
  stressedMetrics: ExtendedMetrics;

  /** Impact analysis */
  impact: {
    pnlImpact: number; // % change in total PnL
    sharpeImpact: number; // % change in Sharpe
    maxDDImpact: number; // % change in max DD
    winRateImpact: number; // % change in win rate
    tradesSkipped: number; // Trades filtered out
    tradesModified: number; // Trades with modified outcome
  };

  /** Pass/fail threshold check */
  passed: boolean;
  failureReason?: string;
}

export interface StressTestSuite {
  /** All scenario results */
  results: StressTestResult[];

  /** Summary statistics */
  summary: {
    scenariosPassed: number;
    scenariosFailed: number;
    avgPnLImpact: number;
    avgSharpeImpact: number;
    worstCaseScenario: string;
    worstCasePnLImpact: number;
  };

  /** Monte Carlo simulation results */
  monteCarlo?: MonteCarloResult;

  /** Overall robustness score (0-100) */
  robustnessScore: number;

  /** Recommendations */
  recommendations: string[];
}

export interface MonteCarloResult {
  /** Number of simulations */
  iterations: number;

  /** Distribution of final PnL */
  pnlDistribution: {
    mean: number;
    median: number;
    std: number;
    percentile5: number;
    percentile25: number;
    percentile75: number;
    percentile95: number;
  };

  /** Probability of ruin (drawdown > threshold) */
  ruinProbability: number;

  /** Expected worst drawdown */
  expectedWorstDD: number;
}

@Injectable()
export class StressTestService {
  private readonly logger = new Logger(StressTestService.name);

  constructor(private readonly metricsCalculator: MetricsCalculatorService) {}

  /**
   * Get predefined stress scenarios
   */
  getPredefinedScenarios(): StressScenario[] {
    return [
      // Execution stress scenarios
      {
        name: 'WIDENED_SPREADS',
        description: 'Bid-ask spread widened 5x during all trades',
        type: 'execution',
        executionOverrides: {
          baseSpreadRate: 0.0005, // 0.05% vs normal 0.01%
        },
      },
      {
        name: 'HIGH_SLIPPAGE',
        description: 'Slippage increased 3x due to low liquidity',
        type: 'execution',
        executionOverrides: {
          baseSlippageRate: 0.0003,
          volatilitySlippageMultiplier: 0.3,
        },
      },
      {
        name: 'PARTIAL_FILLS',
        description: '30% of orders only partially filled',
        type: 'execution',
        tradeModifier: (trade, ctx) => {
          // 30% chance of partial fill (50% of intended size)
          if (Math.random() < 0.3) {
            return {
              ...trade,
              sizeUsd: trade.sizeUsd * 0.5,
              pnl: trade.pnl * 0.5,
            };
          }
          return trade;
        },
      },
      {
        name: 'ADVERSE_FILLS',
        description: 'Entries at worst price, exits at worst price',
        type: 'execution',
        tradeModifier: (trade, ctx) => {
          const adverseSlip = ctx.volatility * 0.5; // 50% of ATR adverse
          const isLong = trade.direction === 'LONG';

          return {
            ...trade,
            entryPrice: isLong
              ? trade.entryPrice * (1 + adverseSlip)
              : trade.entryPrice * (1 - adverseSlip),
            exitPrice: isLong
              ? trade.exitPrice * (1 - adverseSlip)
              : trade.exitPrice * (1 + adverseSlip),
            pnl: this.recalculatePnL(trade, adverseSlip),
          };
        },
      },

      // Market stress scenarios
      {
        name: 'FLASH_CRASH_5PCT',
        description: '5% flash crash during 10% of trades',
        type: 'market',
        tradeModifier: (trade, ctx) => {
          // 10% of trades experience flash crash
          if (ctx.tradeIndex % 10 === 0) {
            const crashImpact = 0.05;
            const isLong = trade.direction === 'LONG';

            // Flash crash hits stop loss for longs, gives bad entry for shorts
            if (isLong && trade.pnl < 0) {
              return {
                ...trade,
                exitPrice: trade.exitPrice * (1 - crashImpact),
                pnl: trade.pnl - trade.sizeUsd * crashImpact,
              };
            }
          }
          return trade;
        },
      },
      {
        name: 'GAP_THROUGH_STOPS',
        description: 'Price gaps through stop loss on 20% of losing trades',
        type: 'market',
        tradeModifier: (trade, ctx) => {
          // Only affect losing trades
          if (trade.pnl < 0 && Math.random() < 0.2) {
            const gapMultiplier = 1.5; // Gap makes loss 50% worse
            return {
              ...trade,
              pnl: trade.pnl * gapMultiplier,
            };
          }
          return trade;
        },
      },
      {
        name: 'VOLATILITY_SPIKE',
        description: 'ATR doubles during 15% of trades',
        type: 'market',
        tradeModifier: (trade, ctx) => {
          if (Math.random() < 0.15) {
            // Higher volatility = wider stops hit more often
            // Simulate by adding random adverse movement
            const spikeImpact = ctx.volatility * 0.3;
            const isLong = trade.direction === 'LONG';
            const adverseMove = isLong ? -spikeImpact : spikeImpact;

            return {
              ...trade,
              pnl: trade.pnl + trade.sizeUsd * adverseMove,
            };
          }
          return trade;
        },
      },
      {
        name: 'TRENDING_REGIME_SHIFT',
        description: 'Market shifts from trending to ranging mid-backtest',
        type: 'market',
        tradeModifier: (trade, ctx) => {
          // Second half of trades: ranging market (worse for trend following)
          if (ctx.tradeIndex > ctx.totalTrades * 0.5) {
            // Reduce winning trades, increase losers
            if (trade.pnl > 0) {
              return { ...trade, pnl: trade.pnl * 0.5 };
            } else {
              return { ...trade, pnl: trade.pnl * 1.2 };
            }
          }
          return trade;
        },
      },

      // System stress scenarios
      {
        name: 'MISSED_ENTRIES',
        description: '10% of trades missed due to system issues',
        type: 'system',
        tradeFilter: (trade, ctx) => {
          // Skip 10% of trades
          return Math.random() > 0.1;
        },
      },
      {
        name: 'DELAYED_EXITS',
        description: 'Exit signals delayed by 1 bar on 20% of trades',
        type: 'system',
        tradeModifier: (trade, ctx) => {
          if (Math.random() < 0.2) {
            // Simulate delay with adverse price movement
            const delayImpact = ctx.volatility * 0.2;
            const isLong = trade.direction === 'LONG';

            return {
              ...trade,
              exitPrice: isLong
                ? trade.exitPrice * (1 - delayImpact)
                : trade.exitPrice * (1 + delayImpact),
              pnl:
                trade.pnl -
                trade.sizeUsd * delayImpact * (isLong ? 1 : -1),
            };
          }
          return trade;
        },
      },
      {
        name: 'DATA_GAPS',
        description: '5% of signals occur during data gaps',
        type: 'system',
        tradeFilter: (trade, ctx) => {
          // Skip 5% of trades due to data gaps
          return Math.random() > 0.05;
        },
      },
      {
        name: 'EXCHANGE_OUTAGE',
        description: 'Simulated 2-hour exchange outage during volatile period',
        type: 'system',
        tradeModifier: (trade, ctx) => {
          // 5% of trades affected by outage
          if (Math.random() < 0.05) {
            // Forced exit at bad price
            const outageImpact = ctx.volatility * 0.5;
            return {
              ...trade,
              pnl: -Math.abs(trade.pnl) - trade.sizeUsd * outageImpact,
            };
          }
          return trade;
        },
      },

      // Combined extreme scenario
      {
        name: 'WORST_CASE_COMBINED',
        description: 'All stress factors combined at reduced probability',
        type: 'market',
        executionOverrides: STRESS_EXECUTION_CONFIG,
        tradeModifier: (trade, ctx) => {
          let modified = { ...trade };

          // 5% chance of each adverse event
          if (Math.random() < 0.05) {
            // Flash crash
            modified.pnl -= trade.sizeUsd * 0.03;
          }
          if (Math.random() < 0.05) {
            // Gap through stop
            if (modified.pnl < 0) {
              modified.pnl *= 1.3;
            }
          }
          if (Math.random() < 0.05) {
            // Delayed exit
            modified.pnl -= trade.sizeUsd * ctx.volatility * 0.1;
          }

          return modified;
        },
        tradeFilter: (trade, ctx) => {
          // 3% missed trades
          return Math.random() > 0.03;
        },
      },
    ];
  }

  /**
   * Run stress test suite
   */
  async runStressTests(
    trades: TradeInput[],
    equityCurve: number[],
    scenarios?: StressScenario[],
    passThresholds?: {
      maxPnLImpact: number;
      maxDDImpact: number;
      minRobustnessScore: number;
    },
  ): Promise<StressTestSuite> {
    const scenariosToRun = scenarios || this.getPredefinedScenarios();
    const thresholds = passThresholds || {
      maxPnLImpact: -50, // Max 50% PnL reduction
      maxDDImpact: 50, // Max 50% increase in max DD
      minRobustnessScore: 60,
    };

    this.logger.log(
      `Running ${scenariosToRun.length} stress test scenarios on ${trades.length} trades`,
    );

    // Calculate baseline metrics
    const baselineMetrics = this.metricsCalculator.calculateExtendedMetrics(
      this.toTradeResults(trades),
      10000, // Initial balance
    );

    // Run each scenario
    const results: StressTestResult[] = [];
    for (const scenario of scenariosToRun) {
      const result = this.runSingleScenario(
        trades,
        equityCurve,
        scenario,
        baselineMetrics,
        thresholds,
      );
      results.push(result);
    }

    // Run Monte Carlo simulation
    const monteCarlo = this.runMonteCarloSimulation(trades, scenariosToRun, 1000);

    // Calculate summary
    const summary = this.calculateSummary(results);
    const robustnessScore = this.calculateRobustnessScore(
      results,
      monteCarlo,
    );
    const recommendations = this.generateRecommendations(
      results,
      monteCarlo,
      robustnessScore,
    );

    return {
      results,
      summary,
      monteCarlo,
      robustnessScore,
      recommendations,
    };
  }

  /**
   * Run single stress scenario
   */
  private runSingleScenario(
    trades: TradeInput[],
    equityCurve: number[],
    scenario: StressScenario,
    baselineMetrics: ExtendedMetrics,
    thresholds: { maxPnLImpact: number; maxDDImpact: number },
  ): StressTestResult {
    let tradesSkipped = 0;
    let tradesModified = 0;

    // Build context
    const avgVolatility = this.estimateVolatility(trades);

    // Apply scenario to trades
    const stressedTrades: TradeInput[] = [];
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i];
      const context: ScenarioContext = {
        volatility: avgVolatility,
        dayOfWeek: new Date(trade.entryTime).getDay(),
        hourOfDay: new Date(trade.entryTime).getHours(),
        priceHistory: trades.slice(Math.max(0, i - 20), i).map((t) => t.entryPrice),
        tradeIndex: i,
        totalTrades: trades.length,
      };

      // Apply filter
      if (scenario.tradeFilter && !scenario.tradeFilter(trade, context)) {
        tradesSkipped++;
        continue;
      }

      // Apply modifier
      let modifiedTrade = { ...trade };
      if (scenario.tradeModifier) {
        modifiedTrade = scenario.tradeModifier(trade, context);
        if (modifiedTrade.pnl !== trade.pnl) {
          tradesModified++;
        }
      }

      stressedTrades.push(modifiedTrade);
    }

    // Build stressed equity curve
    const stressedEquityCurve = this.buildEquityCurve(stressedTrades);

    // Calculate stressed metrics
    const stressedMetrics = this.metricsCalculator.calculateExtendedMetrics(
      this.toTradeResults(stressedTrades),
      10000, // Initial balance
    );

    // Calculate impact
    const pnlImpact = this.percentChange(
      stressedMetrics.basic.totalPnlUsd,
      baselineMetrics.basic.totalPnlUsd,
    );
    const sharpeImpact = this.percentChange(
      stressedMetrics.risk.sharpeRatio,
      baselineMetrics.risk.sharpeRatio,
    );
    const maxDDImpact = this.percentChange(
      stressedMetrics.drawdown.maxDrawdownPercent,
      baselineMetrics.drawdown.maxDrawdownPercent,
    );
    const winRateImpact = this.percentChange(
      stressedMetrics.basic.winRate,
      baselineMetrics.basic.winRate,
    );

    // Check pass/fail
    let passed = true;
    let failureReason: string | undefined;

    if (pnlImpact < thresholds.maxPnLImpact) {
      passed = false;
      failureReason = `PnL impact ${pnlImpact.toFixed(1)}% exceeds threshold ${thresholds.maxPnLImpact}%`;
    } else if (maxDDImpact > thresholds.maxDDImpact) {
      passed = false;
      failureReason = `Max DD impact ${maxDDImpact.toFixed(1)}% exceeds threshold ${thresholds.maxDDImpact}%`;
    }

    return {
      scenario: scenario.name,
      description: scenario.description,
      baselineMetrics,
      stressedMetrics,
      impact: {
        pnlImpact,
        sharpeImpact,
        maxDDImpact,
        winRateImpact,
        tradesSkipped,
        tradesModified,
      },
      passed,
      failureReason,
    };
  }

  /**
   * Run Monte Carlo simulation
   */
  private runMonteCarloSimulation(
    trades: TradeInput[],
    scenarios: StressScenario[],
    iterations: number,
  ): MonteCarloResult {
    const finalPnLs: number[] = [];
    const maxDrawdowns: number[] = [];
    const ruinThreshold = 0.3; // 30% drawdown = ruin

    for (let i = 0; i < iterations; i++) {
      // Shuffle trade order
      const shuffledTrades = this.shuffleArray([...trades]);

      // Randomly apply scenarios with their probability
      const stressedTrades = shuffledTrades.map((trade, idx) => {
        let modified = { ...trade };
        const context: ScenarioContext = {
          volatility: this.estimateVolatility(trades),
          dayOfWeek: new Date(trade.entryTime).getDay(),
          hourOfDay: new Date(trade.entryTime).getHours(),
          priceHistory: [],
          tradeIndex: idx,
          totalTrades: shuffledTrades.length,
        };

        for (const scenario of scenarios) {
          const prob = scenario.probability || 0.1;
          if (Math.random() < prob) {
            if (scenario.tradeModifier) {
              modified = scenario.tradeModifier(modified, context);
            }
          }
        }

        return modified;
      });

      // Calculate final PnL and max DD
      const equityCurve = this.buildEquityCurve(stressedTrades);
      const finalPnL =
        stressedTrades.reduce((sum, t) => sum + t.pnl, 0);
      const maxDD = this.calculateMaxDrawdown(equityCurve);

      finalPnLs.push(finalPnL);
      maxDrawdowns.push(maxDD);
    }

    // Calculate statistics
    finalPnLs.sort((a, b) => a - b);
    const mean = finalPnLs.reduce((a, b) => a + b, 0) / finalPnLs.length;
    const median = finalPnLs[Math.floor(finalPnLs.length / 2)];
    const std = Math.sqrt(
      finalPnLs.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) /
        finalPnLs.length,
    );

    const ruinCount = maxDrawdowns.filter((dd) => dd > ruinThreshold).length;

    return {
      iterations,
      pnlDistribution: {
        mean,
        median,
        std,
        percentile5: finalPnLs[Math.floor(finalPnLs.length * 0.05)],
        percentile25: finalPnLs[Math.floor(finalPnLs.length * 0.25)],
        percentile75: finalPnLs[Math.floor(finalPnLs.length * 0.75)],
        percentile95: finalPnLs[Math.floor(finalPnLs.length * 0.95)],
      },
      ruinProbability: (ruinCount / iterations) * 100,
      expectedWorstDD:
        maxDrawdowns.reduce((a, b) => a + b, 0) / maxDrawdowns.length,
    };
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(
    results: StressTestResult[],
  ): StressTestSuite['summary'] {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    const avgPnLImpact =
      results.reduce((sum, r) => sum + r.impact.pnlImpact, 0) / results.length;
    const avgSharpeImpact =
      results.reduce((sum, r) => sum + r.impact.sharpeImpact, 0) /
      results.length;

    // Find worst case
    const worstCase = results.reduce(
      (worst, r) =>
        r.impact.pnlImpact < worst.impact.pnlImpact ? r : worst,
      results[0],
    );

    return {
      scenariosPassed: passed,
      scenariosFailed: failed,
      avgPnLImpact,
      avgSharpeImpact,
      worstCaseScenario: worstCase.scenario,
      worstCasePnLImpact: worstCase.impact.pnlImpact,
    };
  }

  /**
   * Calculate overall robustness score
   */
  private calculateRobustnessScore(
    results: StressTestResult[],
    monteCarlo: MonteCarloResult,
  ): number {
    let score = 100;

    // Deduct for failed scenarios
    const failedPct =
      (results.filter((r) => !r.passed).length / results.length) * 100;
    score -= failedPct * 0.5;

    // Deduct for high average impact
    const avgImpact = Math.abs(
      results.reduce((sum, r) => sum + r.impact.pnlImpact, 0) / results.length,
    );
    score -= Math.min(avgImpact, 30);

    // Deduct for high ruin probability
    score -= Math.min(monteCarlo.ruinProbability * 2, 20);

    // Deduct for high variance in Monte Carlo
    const coeffOfVariation = monteCarlo.pnlDistribution.std /
      Math.abs(monteCarlo.pnlDistribution.mean || 1);
    score -= Math.min(coeffOfVariation * 10, 15);

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    results: StressTestResult[],
    monteCarlo: MonteCarloResult,
    robustnessScore: number,
  ): string[] {
    const recommendations: string[] = [];

    // Failed scenarios
    const failedScenarios = results.filter((r) => !r.passed);
    if (failedScenarios.length > 0) {
      recommendations.push(
        `WARNING: ${failedScenarios.length} stress scenarios failed. Review: ${failedScenarios.map((s) => s.scenario).join(', ')}`,
      );
    }

    // Ruin probability
    if (monteCarlo.ruinProbability > 10) {
      recommendations.push(
        `CRITICAL: ${monteCarlo.ruinProbability.toFixed(1)}% probability of 30%+ drawdown. Consider reducing position sizes.`,
      );
    } else if (monteCarlo.ruinProbability > 5) {
      recommendations.push(
        `CAUTION: ${monteCarlo.ruinProbability.toFixed(1)}% probability of significant drawdown. Monitor closely.`,
      );
    }

    // Execution sensitivity
    const executionScenarios = results.filter(
      (r) => r.scenario.includes('SPREAD') || r.scenario.includes('SLIPPAGE'),
    );
    const avgExecImpact =
      executionScenarios.reduce((sum, r) => sum + r.impact.pnlImpact, 0) /
      (executionScenarios.length || 1);
    if (avgExecImpact < -20) {
      recommendations.push(
        'Strategy is sensitive to execution costs. Consider using limit orders or trading more liquid markets.',
      );
    }

    // Gap risk
    const gapScenario = results.find((r) => r.scenario.includes('GAP'));
    if (gapScenario && gapScenario.impact.pnlImpact < -15) {
      recommendations.push(
        'Strategy vulnerable to gap risk. Consider wider stops or avoiding overnight positions.',
      );
    }

    // System failure resilience
    const systemScenarios = results.filter((r) =>
      ['MISSED_ENTRIES', 'DELAYED_EXITS', 'EXCHANGE_OUTAGE'].includes(
        r.scenario,
      ),
    );
    const avgSystemImpact =
      systemScenarios.reduce((sum, r) => sum + r.impact.pnlImpact, 0) /
      (systemScenarios.length || 1);
    if (avgSystemImpact < -10) {
      recommendations.push(
        'Strategy sensitive to system issues. Implement redundancy and monitoring.',
      );
    }

    // Overall score
    if (robustnessScore >= 80) {
      recommendations.push(
        `POSITIVE: Robustness score ${robustnessScore.toFixed(0)}/100 - Strategy shows good resilience to stress.`,
      );
    } else if (robustnessScore >= 60) {
      recommendations.push(
        `MODERATE: Robustness score ${robustnessScore.toFixed(0)}/100 - Strategy has acceptable stress tolerance.`,
      );
    } else {
      recommendations.push(
        `WARNING: Robustness score ${robustnessScore.toFixed(0)}/100 - Strategy needs improvement before live trading.`,
      );
    }

    return recommendations;
  }

  // Helper methods

  private estimateVolatility(trades: TradeInput[]): number {
    if (trades.length < 2) return 0.02;

    const returns = trades.map(
      (t) => Math.abs(t.exitPrice - t.entryPrice) / t.entryPrice,
    );
    return returns.reduce((a, b) => a + b, 0) / returns.length;
  }

  private recalculatePnL(trade: TradeInput, adverseSlip: number): number {
    const isLong = trade.direction === 'LONG';
    const adjustedEntry = isLong
      ? trade.entryPrice * (1 + adverseSlip)
      : trade.entryPrice * (1 - adverseSlip);
    const adjustedExit = isLong
      ? trade.exitPrice * (1 - adverseSlip)
      : trade.exitPrice * (1 + adverseSlip);

    const priceDiff = isLong
      ? adjustedExit - adjustedEntry
      : adjustedEntry - adjustedExit;

    return (priceDiff / trade.entryPrice) * trade.sizeUsd;
  }

  private percentChange(newVal: number, oldVal: number): number {
    if (oldVal === 0) return newVal === 0 ? 0 : newVal > 0 ? 100 : -100;
    return ((newVal - oldVal) / Math.abs(oldVal)) * 100;
  }

  private buildEquityCurve(trades: TradeInput[]): number[] {
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

  private shuffleArray<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Convert TradeInput to TradeResult for metrics calculation
   */
  private toTradeResults(trades: TradeInput[]): TradeResult[] {
    return trades.map((t) => ({
      pnlUsd: t.pnl,
      pnlPercent: (t.pnl / t.sizeUsd) * 100,
      entryTime: new Date(t.entryTime),
      exitTime: new Date(t.exitTime),
      isWin: t.pnl > 0,
    }));
  }
}
