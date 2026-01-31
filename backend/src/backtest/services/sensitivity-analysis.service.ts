/**
 * Parameter Sensitivity Analysis Service
 *
 * Analyzes how strategy performance changes with parameter variations:
 * - One-at-a-time sensitivity (change one parameter, hold others fixed)
 * - Pairwise sensitivity (interaction effects between parameters)
 * - Stability regions (parameter ranges where performance is consistent)
 *
 * Purpose: Identify overfitting and find robust parameter combinations
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  ExtendedMetrics,
  MetricsCalculatorService,
  TradeResult,
} from './metrics-calculator.service';

export interface ParameterSpec {
  name: string;
  baseValue: number;
  minValue: number;
  maxValue: number;
  step: number;
  description?: string;
}

export interface SensitivityPoint {
  value: number;
  metrics: {
    sharpeRatio: number;
    totalPnL: number;
    winRate: number;
    maxDrawdown: number;
    profitFactor: number;
    totalTrades: number;
  };
}

export interface ParameterSensitivity {
  parameter: ParameterSpec;
  points: SensitivityPoint[];

  /** Sensitivity score: how much does metric change per unit parameter change */
  sensitivity: {
    sharpe: number;
    pnl: number;
    winRate: number;
    maxDD: number;
  };

  /** Is there a clear optimal value? */
  hasOptimum: boolean;
  optimumValue?: number;

  /** Stability: % of tested values that produce positive results */
  stabilityScore: number;

  /** Range where Sharpe > 0.5 */
  stableRange?: { min: number; max: number };

  /** Monotonic relationship? */
  isMonotonic: boolean;
  direction?: 'increasing' | 'decreasing';
}

export interface PairwiseSensitivity {
  param1: string;
  param2: string;

  /** Grid of results */
  grid: {
    param1Value: number;
    param2Value: number;
    sharpeRatio: number;
    totalPnL: number;
  }[][];

  /** Interaction strength (0-1) */
  interactionStrength: number;

  /** Is there synergy or conflict? */
  relationship: 'synergistic' | 'conflicting' | 'independent';

  /** Optimal combination */
  optimalCombination?: {
    param1: number;
    param2: number;
    sharpe: number;
  };
}

export interface SensitivityAnalysisResult {
  /** Base parameters used */
  baseParams: Record<string, number>;

  /** Base metrics */
  baseMetrics: ExtendedMetrics;

  /** Individual parameter sensitivities */
  sensitivities: ParameterSensitivity[];

  /** Pairwise interactions */
  pairwise?: PairwiseSensitivity[];

  /** Overall robustness assessment */
  robustness: {
    /** Average stability across parameters */
    avgStability: number;

    /** Most sensitive parameter */
    mostSensitive: string;

    /** Least sensitive parameter */
    leastSensitive: string;

    /** Overall robustness score (0-100) */
    score: number;

    /** Risk of overfitting */
    overfittingRisk: 'low' | 'medium' | 'high';
  };

  /** Suggested parameter adjustments */
  suggestions: {
    parameter: string;
    currentValue: number;
    suggestedValue: number;
    reason: string;
    expectedImprovement: string;
  }[];

  /** Warnings and recommendations */
  warnings: string[];
  recommendations: string[];
}

export interface BacktestRunner {
  runBacktest(params: Record<string, number>): Promise<{
    trades: TradeResult[];
    equityCurve: number[];
  }>;
}

@Injectable()
export class SensitivityAnalysisService {
  private readonly logger = new Logger(SensitivityAnalysisService.name);

  constructor(private readonly metricsCalculator: MetricsCalculatorService) {}

  /**
   * Run comprehensive sensitivity analysis
   */
  async analyzeSensitivity(
    runner: BacktestRunner,
    parameterSpecs: ParameterSpec[],
    baseParams: Record<string, number>,
    options: {
      includePairwise?: boolean;
      pairwiseGridSize?: number;
    } = {},
  ): Promise<SensitivityAnalysisResult> {
    this.logger.log(
      `Starting sensitivity analysis for ${parameterSpecs.length} parameters`,
    );

    // Run base case
    const baseResult = await runner.runBacktest(baseParams);
    const baseMetrics = this.metricsCalculator.calculateExtendedMetrics(
      baseResult.trades,
      10000, // Initial balance
    );

    // Analyze each parameter individually
    const sensitivities: ParameterSensitivity[] = [];
    for (const spec of parameterSpecs) {
      this.logger.log(`Analyzing sensitivity for ${spec.name}`);
      const sensitivity = await this.analyzeParameter(
        runner,
        spec,
        baseParams,
      );
      sensitivities.push(sensitivity);
    }

    // Pairwise analysis (optional, computationally expensive)
    let pairwise: PairwiseSensitivity[] | undefined;
    if (options.includePairwise && parameterSpecs.length >= 2) {
      pairwise = await this.analyzePairwise(
        runner,
        parameterSpecs,
        baseParams,
        options.pairwiseGridSize || 5,
      );
    }

    // Calculate overall robustness
    const robustness = this.calculateRobustness(sensitivities);

    // Generate suggestions
    const suggestions = this.generateSuggestions(sensitivities, baseParams);

    // Generate warnings and recommendations
    const { warnings, recommendations } = this.generateWarningsAndRecommendations(
      sensitivities,
      pairwise,
      robustness,
    );

    return {
      baseParams,
      baseMetrics,
      sensitivities,
      pairwise,
      robustness,
      suggestions,
      warnings,
      recommendations,
    };
  }

  /**
   * Analyze sensitivity for a single parameter
   */
  private async analyzeParameter(
    runner: BacktestRunner,
    spec: ParameterSpec,
    baseParams: Record<string, number>,
  ): Promise<ParameterSensitivity> {
    const points: SensitivityPoint[] = [];

    // Generate test values
    const testValues: number[] = [];
    for (let v = spec.minValue; v <= spec.maxValue; v += spec.step) {
      testValues.push(v);
    }

    // Ensure base value is included
    if (!testValues.includes(spec.baseValue)) {
      testValues.push(spec.baseValue);
      testValues.sort((a, b) => a - b);
    }

    // Run backtest for each value
    for (const value of testValues) {
      const params = { ...baseParams, [spec.name]: value };
      const result = await runner.runBacktest(params);

      if (result.trades.length === 0) {
        points.push({
          value,
          metrics: {
            sharpeRatio: 0,
            totalPnL: 0,
            winRate: 0,
            maxDrawdown: 0,
            profitFactor: 0,
            totalTrades: 0,
          },
        });
        continue;
      }

      const metrics = this.metricsCalculator.calculateExtendedMetrics(
        result.trades,
        10000, // Initial balance
      );

      points.push({
        value,
        metrics: {
          sharpeRatio: metrics.risk.sharpeRatio,
          totalPnL: metrics.basic.totalPnlUsd,
          winRate: metrics.basic.winRate,
          maxDrawdown: metrics.drawdown.maxDrawdownPercent,
          profitFactor: metrics.basic.profitFactor,
          totalTrades: metrics.basic.totalTrades,
        },
      });
    }

    // Calculate sensitivity metrics
    const sensitivity = this.calculateSensitivityMetrics(points, spec);
    const { hasOptimum, optimumValue } = this.findOptimum(points);
    const stabilityScore = this.calculateStability(points);
    const stableRange = this.findStableRange(points);
    const { isMonotonic, direction } = this.checkMonotonicity(points);

    return {
      parameter: spec,
      points,
      sensitivity,
      hasOptimum,
      optimumValue,
      stabilityScore,
      stableRange,
      isMonotonic,
      direction,
    };
  }

  /**
   * Calculate sensitivity coefficients
   */
  private calculateSensitivityMetrics(
    points: SensitivityPoint[],
    spec: ParameterSpec,
  ): ParameterSensitivity['sensitivity'] {
    if (points.length < 2) {
      return { sharpe: 0, pnl: 0, winRate: 0, maxDD: 0 };
    }

    // Calculate normalized derivatives
    const paramRange = spec.maxValue - spec.minValue;

    const sharpeValues = points.map((p) => p.metrics.sharpeRatio);
    const pnlValues = points.map((p) => p.metrics.totalPnL);
    const wrValues = points.map((p) => p.metrics.winRate);
    const ddValues = points.map((p) => p.metrics.maxDrawdown);

    const sharpeRange = Math.max(...sharpeValues) - Math.min(...sharpeValues);
    const pnlRange = Math.max(...pnlValues) - Math.min(...pnlValues);
    const wrRange = Math.max(...wrValues) - Math.min(...wrValues);
    const ddRange = Math.max(...ddValues) - Math.min(...ddValues);

    // Normalized sensitivity = metric range / param range
    return {
      sharpe: sharpeRange / (paramRange || 1),
      pnl: pnlRange / (paramRange || 1),
      winRate: wrRange / (paramRange || 1),
      maxDD: ddRange / (paramRange || 1),
    };
  }

  /**
   * Find optimum value
   */
  private findOptimum(
    points: SensitivityPoint[],
  ): { hasOptimum: boolean; optimumValue?: number } {
    if (points.length < 3) {
      return { hasOptimum: false };
    }

    // Find max Sharpe point
    const maxSharpePoint = points.reduce((max, p) =>
      p.metrics.sharpeRatio > max.metrics.sharpeRatio ? p : max,
    );

    // Check if it's interior (not at boundary)
    const maxIdx = points.indexOf(maxSharpePoint);
    const isInterior = maxIdx > 0 && maxIdx < points.length - 1;

    // Check if significantly better than neighbors
    const threshold = 0.1;
    if (isInterior) {
      const leftSharpe = points[maxIdx - 1].metrics.sharpeRatio;
      const rightSharpe = points[maxIdx + 1].metrics.sharpeRatio;
      const improvement = Math.min(
        maxSharpePoint.metrics.sharpeRatio - leftSharpe,
        maxSharpePoint.metrics.sharpeRatio - rightSharpe,
      );

      if (improvement > threshold) {
        return { hasOptimum: true, optimumValue: maxSharpePoint.value };
      }
    }

    return { hasOptimum: false };
  }

  /**
   * Calculate stability score
   */
  private calculateStability(points: SensitivityPoint[]): number {
    if (points.length === 0) return 0;

    // Count points with positive Sharpe
    const positiveCount = points.filter(
      (p) => p.metrics.sharpeRatio > 0,
    ).length;

    return (positiveCount / points.length) * 100;
  }

  /**
   * Find range where Sharpe > threshold
   */
  private findStableRange(
    points: SensitivityPoint[],
    threshold: number = 0.5,
  ): { min: number; max: number } | undefined {
    const stablePoints = points.filter(
      (p) => p.metrics.sharpeRatio > threshold,
    );

    if (stablePoints.length === 0) return undefined;

    return {
      min: Math.min(...stablePoints.map((p) => p.value)),
      max: Math.max(...stablePoints.map((p) => p.value)),
    };
  }

  /**
   * Check if relationship is monotonic
   */
  private checkMonotonicity(
    points: SensitivityPoint[],
  ): { isMonotonic: boolean; direction?: 'increasing' | 'decreasing' } {
    if (points.length < 3) {
      return { isMonotonic: false };
    }

    let increasing = 0;
    let decreasing = 0;

    for (let i = 1; i < points.length; i++) {
      const diff =
        points[i].metrics.sharpeRatio - points[i - 1].metrics.sharpeRatio;
      if (diff > 0.05) increasing++;
      else if (diff < -0.05) decreasing++;
    }

    const total = increasing + decreasing;
    if (total === 0) return { isMonotonic: false };

    if (increasing / total > 0.8) {
      return { isMonotonic: true, direction: 'increasing' };
    }
    if (decreasing / total > 0.8) {
      return { isMonotonic: true, direction: 'decreasing' };
    }

    return { isMonotonic: false };
  }

  /**
   * Analyze pairwise interactions
   */
  private async analyzePairwise(
    runner: BacktestRunner,
    specs: ParameterSpec[],
    baseParams: Record<string, number>,
    gridSize: number,
  ): Promise<PairwiseSensitivity[]> {
    const results: PairwiseSensitivity[] = [];

    // Analyze top pairs (limit to avoid combinatorial explosion)
    const maxPairs = 6;
    const pairs: [ParameterSpec, ParameterSpec][] = [];

    for (let i = 0; i < specs.length && pairs.length < maxPairs; i++) {
      for (let j = i + 1; j < specs.length && pairs.length < maxPairs; j++) {
        pairs.push([specs[i], specs[j]]);
      }
    }

    for (const [spec1, spec2] of pairs) {
      this.logger.log(`Analyzing pairwise: ${spec1.name} x ${spec2.name}`);

      // Generate grid values
      const values1 = this.generateGridValues(spec1, gridSize);
      const values2 = this.generateGridValues(spec2, gridSize);

      const grid: PairwiseSensitivity['grid'] = [];

      for (const v1 of values1) {
        const row: PairwiseSensitivity['grid'][0] = [];
        for (const v2 of values2) {
          const params = {
            ...baseParams,
            [spec1.name]: v1,
            [spec2.name]: v2,
          };

          const result = await runner.runBacktest(params);
          const metrics = this.metricsCalculator.calculateExtendedMetrics(
            result.trades,
            10000, // Initial balance
          );

          row.push({
            param1Value: v1,
            param2Value: v2,
            sharpeRatio: metrics.risk.sharpeRatio,
            totalPnL: metrics.basic.totalPnlUsd,
          });
        }
        grid.push(row);
      }

      // Calculate interaction strength
      const interactionStrength = this.calculateInteractionStrength(grid);
      const relationship = this.determineRelationship(grid);
      const optimalCombination = this.findOptimalCombination(grid);

      results.push({
        param1: spec1.name,
        param2: spec2.name,
        grid,
        interactionStrength,
        relationship,
        optimalCombination,
      });
    }

    return results;
  }

  /**
   * Generate grid values for a parameter
   */
  private generateGridValues(spec: ParameterSpec, gridSize: number): number[] {
    const values: number[] = [];
    const step = (spec.maxValue - spec.minValue) / (gridSize - 1);

    for (let i = 0; i < gridSize; i++) {
      values.push(spec.minValue + i * step);
    }

    return values;
  }

  /**
   * Calculate interaction strength between two parameters
   */
  private calculateInteractionStrength(
    grid: PairwiseSensitivity['grid'],
  ): number {
    if (grid.length < 2 || grid[0].length < 2) return 0;

    // Calculate variance of row effects
    const rowMeans = grid.map(
      (row) => row.reduce((sum, p) => sum + p.sharpeRatio, 0) / row.length,
    );

    // Calculate variance of column effects
    const colMeans: number[] = [];
    for (let j = 0; j < grid[0].length; j++) {
      const colSum = grid.reduce((sum, row) => sum + row[j].sharpeRatio, 0);
      colMeans.push(colSum / grid.length);
    }

    // Calculate residuals (interaction effects)
    const grandMean =
      grid.flat().reduce((sum, p) => sum + p.sharpeRatio, 0) /
      (grid.length * grid[0].length);

    let interactionSS = 0;
    let totalSS = 0;

    for (let i = 0; i < grid.length; i++) {
      for (let j = 0; j < grid[i].length; j++) {
        const predicted = grandMean + (rowMeans[i] - grandMean) + (colMeans[j] - grandMean);
        const residual = grid[i][j].sharpeRatio - predicted;
        interactionSS += residual * residual;
        totalSS += Math.pow(grid[i][j].sharpeRatio - grandMean, 2);
      }
    }

    // Interaction strength = proportion of variance explained by interaction
    return totalSS > 0 ? interactionSS / totalSS : 0;
  }

  /**
   * Determine relationship type between parameters
   */
  private determineRelationship(
    grid: PairwiseSensitivity['grid'],
  ): PairwiseSensitivity['relationship'] {
    // Check if increasing both improves or worsens performance
    const cornerValues = [
      grid[0][0].sharpeRatio, // low-low
      grid[0][grid[0].length - 1].sharpeRatio, // low-high
      grid[grid.length - 1][0].sharpeRatio, // high-low
      grid[grid.length - 1][grid[0].length - 1].sharpeRatio, // high-high
    ];

    const bothHigh = cornerValues[3];
    const bothLow = cornerValues[0];
    const mixed1 = cornerValues[1];
    const mixed2 = cornerValues[2];

    const sameDirectionBetter = bothHigh > mixed1 && bothHigh > mixed2;
    const oppositeDirectionBetter = (mixed1 + mixed2) / 2 > (bothHigh + bothLow) / 2;

    if (sameDirectionBetter) return 'synergistic';
    if (oppositeDirectionBetter) return 'conflicting';
    return 'independent';
  }

  /**
   * Find optimal combination
   */
  private findOptimalCombination(
    grid: PairwiseSensitivity['grid'],
  ): PairwiseSensitivity['optimalCombination'] {
    let best: PairwiseSensitivity['optimalCombination'];
    let maxSharpe = -Infinity;

    for (const row of grid) {
      for (const point of row) {
        if (point.sharpeRatio > maxSharpe) {
          maxSharpe = point.sharpeRatio;
          best = {
            param1: point.param1Value,
            param2: point.param2Value,
            sharpe: point.sharpeRatio,
          };
        }
      }
    }

    return best;
  }

  /**
   * Calculate overall robustness
   */
  private calculateRobustness(
    sensitivities: ParameterSensitivity[],
  ): SensitivityAnalysisResult['robustness'] {
    if (sensitivities.length === 0) {
      return {
        avgStability: 0,
        mostSensitive: 'N/A',
        leastSensitive: 'N/A',
        score: 0,
        overfittingRisk: 'high',
      };
    }

    // Average stability
    const avgStability =
      sensitivities.reduce((sum, s) => sum + s.stabilityScore, 0) /
      sensitivities.length;

    // Find most/least sensitive
    const sorted = [...sensitivities].sort(
      (a, b) => b.sensitivity.sharpe - a.sensitivity.sharpe,
    );
    const mostSensitive = sorted[0].parameter.name;
    const leastSensitive = sorted[sorted.length - 1].parameter.name;

    // Calculate robustness score
    let score = 50; // Base score

    // Bonus for high stability
    score += (avgStability - 50) * 0.3;

    // Bonus for parameters with stable ranges
    const withStableRanges = sensitivities.filter((s) => s.stableRange).length;
    score += (withStableRanges / sensitivities.length) * 20;

    // Penalty for high sensitivity
    const avgSensitivity =
      sensitivities.reduce((sum, s) => sum + s.sensitivity.sharpe, 0) /
      sensitivities.length;
    score -= Math.min(avgSensitivity * 10, 20);

    score = Math.max(0, Math.min(100, score));

    // Determine overfitting risk
    let overfittingRisk: 'low' | 'medium' | 'high';
    if (score >= 70 && avgStability >= 70) {
      overfittingRisk = 'low';
    } else if (score >= 50 && avgStability >= 50) {
      overfittingRisk = 'medium';
    } else {
      overfittingRisk = 'high';
    }

    return {
      avgStability,
      mostSensitive,
      leastSensitive,
      score,
      overfittingRisk,
    };
  }

  /**
   * Generate parameter adjustment suggestions
   */
  private generateSuggestions(
    sensitivities: ParameterSensitivity[],
    baseParams: Record<string, number>,
  ): SensitivityAnalysisResult['suggestions'] {
    const suggestions: SensitivityAnalysisResult['suggestions'] = [];

    for (const sens of sensitivities) {
      const currentValue = baseParams[sens.parameter.name];

      // Suggest moving to optimum if found
      if (sens.hasOptimum && sens.optimumValue !== currentValue) {
        suggestions.push({
          parameter: sens.parameter.name,
          currentValue,
          suggestedValue: sens.optimumValue!,
          reason: 'Clear optimum detected in sensitivity analysis',
          expectedImprovement: 'Potentially higher Sharpe ratio',
        });
        continue;
      }

      // Suggest moving towards stable range
      if (sens.stableRange) {
        if (currentValue < sens.stableRange.min) {
          suggestions.push({
            parameter: sens.parameter.name,
            currentValue,
            suggestedValue: sens.stableRange.min,
            reason: 'Current value below stable range',
            expectedImprovement: 'More consistent performance',
          });
        } else if (currentValue > sens.stableRange.max) {
          suggestions.push({
            parameter: sens.parameter.name,
            currentValue,
            suggestedValue: sens.stableRange.max,
            reason: 'Current value above stable range',
            expectedImprovement: 'More consistent performance',
          });
        }
      }

      // For monotonic relationships, suggest extreme
      if (sens.isMonotonic) {
        const suggestedValue =
          sens.direction === 'increasing'
            ? sens.parameter.maxValue
            : sens.parameter.minValue;

        if (suggestedValue !== currentValue) {
          suggestions.push({
            parameter: sens.parameter.name,
            currentValue,
            suggestedValue,
            reason: `Monotonic ${sens.direction} relationship detected`,
            expectedImprovement: 'Higher Sharpe at extreme value',
          });
        }
      }
    }

    return suggestions;
  }

  /**
   * Generate warnings and recommendations
   */
  private generateWarningsAndRecommendations(
    sensitivities: ParameterSensitivity[],
    pairwise: PairwiseSensitivity[] | undefined,
    robustness: SensitivityAnalysisResult['robustness'],
  ): { warnings: string[]; recommendations: string[] } {
    const warnings: string[] = [];
    const recommendations: string[] = [];

    // Stability warnings
    for (const sens of sensitivities) {
      if (sens.stabilityScore < 30) {
        warnings.push(
          `WARNING: ${sens.parameter.name} is highly unstable. Only ${sens.stabilityScore.toFixed(0)}% of values produce positive Sharpe.`,
        );
      }
    }

    // High sensitivity warnings
    const highSensitivity = sensitivities.filter((s) => s.sensitivity.sharpe > 0.5);
    if (highSensitivity.length > 0) {
      warnings.push(
        `CAUTION: ${highSensitivity.map((s) => s.parameter.name).join(', ')} show high sensitivity. Small changes significantly affect performance.`,
      );
    }

    // No optimum found
    const noOptimum = sensitivities.filter((s) => !s.hasOptimum);
    if (noOptimum.length > sensitivities.length / 2) {
      recommendations.push(
        'Most parameters lack clear optima. Consider expanding parameter ranges or using different optimization criteria.',
      );
    }

    // Overfitting risk
    if (robustness.overfittingRisk === 'high') {
      warnings.push(
        'HIGH OVERFITTING RISK: Strategy is sensitive to parameter choices. Results may not generalize to live trading.',
      );
      recommendations.push(
        'Consider simplifying strategy (fewer parameters), using regularization, or expanding training data.',
      );
    }

    // Pairwise warnings
    if (pairwise) {
      const strongInteractions = pairwise.filter((p) => p.interactionStrength > 0.3);
      if (strongInteractions.length > 0) {
        warnings.push(
          `Strong parameter interactions detected: ${strongInteractions.map((p) => `${p.param1}×${p.param2}`).join(', ')}`,
        );
        recommendations.push(
          'Parameters with strong interactions should be optimized together, not independently.',
        );
      }

      const conflicting = pairwise.filter((p) => p.relationship === 'conflicting');
      if (conflicting.length > 0) {
        recommendations.push(
          `Conflicting relationships: ${conflicting.map((p) => `${p.param1}/${p.param2}`).join(', ')}. Consider removing one parameter from each pair.`,
        );
      }
    }

    // Positive signals
    if (robustness.score >= 70) {
      recommendations.push(
        `POSITIVE: Robustness score ${robustness.score.toFixed(0)}/100 indicates reasonable parameter stability.`,
      );
    }

    if (robustness.avgStability >= 80) {
      recommendations.push(
        `POSITIVE: ${robustness.avgStability.toFixed(0)}% average stability - strategy works across wide parameter ranges.`,
      );
    }

    return { warnings, recommendations };
  }
}
