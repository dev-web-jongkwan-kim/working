/**
 * Unified Validation Pipeline Service
 *
 * Integrates all validation components into a single pipeline:
 * - Realistic execution model
 * - Extended risk metrics
 * - Walk-forward validation
 * - Stress testing
 * - Regime analysis
 * - Parameter sensitivity
 *
 * Purpose: Comprehensive strategy validation before live deployment
 */

import { Injectable, Logger } from '@nestjs/common';
import { MetricsCalculatorService, ExtendedMetrics, TradeResult } from './metrics-calculator.service';
import { WalkForwardService, WalkForwardResult, WalkForwardConfig } from './walk-forward.service';
import { StressTestService, StressTestSuite, TradeInput } from './stress-test.service';
import { RegimeAnalysisService, RegimeAnalysisResult, CandleData, TradeData } from './regime-analysis.service';
import { SensitivityAnalysisService, SensitivityAnalysisResult, ParameterSpec } from './sensitivity-analysis.service';

export interface ValidationPipelineConfig {
  /** Strategy name for reporting */
  strategyName: string;

  /** Minimum acceptable Sharpe ratio */
  minSharpe: number;

  /** Maximum acceptable drawdown % */
  maxDrawdown: number;

  /** Minimum walk-forward efficiency */
  minWalkForwardEfficiency: number;

  /** Minimum stress test robustness score */
  minStressRobustness: number;

  /** Maximum regime sensitivity */
  maxRegimeSensitivity: number;

  /** Maximum overfitting risk level */
  maxOverfittingRisk: 'low' | 'medium' | 'high';

  /** Skip individual validations */
  skip?: {
    walkForward?: boolean;
    stressTest?: boolean;
    regimeAnalysis?: boolean;
    sensitivityAnalysis?: boolean;
  };
}

export interface ValidationStageResult {
  stage: string;
  passed: boolean;
  score: number; // 0-100
  details: string;
  warnings: string[];
  criticalIssues: string[];
}

export interface ValidationPipelineResult {
  /** Strategy identifier */
  strategyName: string;

  /** Validation timestamp */
  timestamp: Date;

  /** Overall pass/fail */
  passed: boolean;

  /** Overall validation score (0-100) */
  overallScore: number;

  /** Deployment readiness level */
  deploymentReadiness: 'ready' | 'conditional' | 'not_ready';

  /** Stage results */
  stages: {
    metrics: ValidationStageResult;
    walkForward?: ValidationStageResult;
    stressTest?: ValidationStageResult;
    regimeAnalysis?: ValidationStageResult;
    sensitivity?: ValidationStageResult;
  };

  /** Detailed results */
  details: {
    metrics: ExtendedMetrics;
    walkForward?: WalkForwardResult;
    stressTest?: StressTestSuite;
    regime?: RegimeAnalysisResult;
    sensitivity?: SensitivityAnalysisResult;
  };

  /** Aggregated recommendations */
  recommendations: {
    critical: string[];
    important: string[];
    suggestions: string[];
  };

  /** Deployment checklist */
  deploymentChecklist: {
    item: string;
    status: 'pass' | 'fail' | 'warning';
    notes: string;
  }[];

  /** Summary for stakeholders */
  executiveSummary: string;
}

export interface BacktestDataProvider {
  /** Get candle data for regime analysis */
  getCandles(): CandleData[];

  /** Get trade results */
  getTrades(): TradeInput[];

  /** Get equity curve */
  getEquityCurve(): number[];

  /** Run backtest with specific parameters */
  runBacktest(params: Record<string, number>): Promise<{
    trades: TradeResult[];
    equityCurve: number[];
  }>;

  /** Run backtest for date range (walk-forward) */
  runBacktestRange(
    startDate: Date,
    endDate: Date,
    params: Record<string, number>,
  ): Promise<{
    trades: TradeResult[];
    equityCurve: number[];
  }>;
}

const DEFAULT_CONFIG: ValidationPipelineConfig = {
  strategyName: 'Unnamed Strategy',
  minSharpe: 0.5,
  maxDrawdown: 25,
  minWalkForwardEfficiency: 0.6,
  minStressRobustness: 50,
  maxRegimeSensitivity: 60,
  maxOverfittingRisk: 'medium',
};

@Injectable()
export class ValidationPipelineService {
  private readonly logger = new Logger(ValidationPipelineService.name);

  constructor(
    private readonly metricsCalculator: MetricsCalculatorService,
    private readonly walkForwardService: WalkForwardService,
    private readonly stressTestService: StressTestService,
    private readonly regimeAnalysisService: RegimeAnalysisService,
    private readonly sensitivityService: SensitivityAnalysisService,
  ) {}

  /**
   * Run full validation pipeline
   */
  async runValidation(
    dataProvider: BacktestDataProvider,
    config: Partial<ValidationPipelineConfig> = {},
    parameterSpecs?: ParameterSpec[],
    baseParams?: Record<string, number>,
  ): Promise<ValidationPipelineResult> {
    const fullConfig = { ...DEFAULT_CONFIG, ...config };
    this.logger.log(`Starting validation pipeline for ${fullConfig.strategyName}`);

    const trades = dataProvider.getTrades();
    const equityCurve = dataProvider.getEquityCurve();
    const candles = dataProvider.getCandles();

    // Stage 1: Basic Metrics
    this.logger.log('Stage 1: Calculating extended metrics...');
    const metricsResult = this.metricsCalculator.calculateExtendedMetrics(
      this.toTradeResults(trades),
      10000, // Initial balance
    );
    const metricsStage = this.validateMetrics(metricsResult, fullConfig);

    // Stage 2: Walk-Forward Validation
    let walkForwardStage: ValidationStageResult | undefined;
    let walkForwardResult: WalkForwardResult | undefined;

    if (!fullConfig.skip?.walkForward) {
      this.logger.log('Stage 2: Running walk-forward validation...');
      walkForwardResult = await this.walkForwardService.runWalkForward(
        {
          runBacktest: (start, end, params) =>
            dataProvider.runBacktestRange(start, end, params),
        },
        new Date(Math.min(...trades.map((t) => t.entryTime))),
        new Date(Math.max(...trades.map((t) => t.exitTime))),
        {
          trainWindowDays: 180,
          testWindowDays: 30,
          stepDays: 30,
        },
        baseParams || {},
      );
      walkForwardStage = this.validateWalkForward(walkForwardResult, fullConfig);
    }

    // Stage 3: Stress Testing
    let stressStage: ValidationStageResult | undefined;
    let stressResult: StressTestSuite | undefined;

    if (!fullConfig.skip?.stressTest) {
      this.logger.log('Stage 3: Running stress tests...');
      stressResult = await this.stressTestService.runStressTests(
        trades,
        equityCurve,
      );
      stressStage = this.validateStressTest(stressResult, fullConfig);
    }

    // Stage 4: Regime Analysis
    let regimeStage: ValidationStageResult | undefined;
    let regimeResult: RegimeAnalysisResult | undefined;

    if (!fullConfig.skip?.regimeAnalysis && candles.length > 0) {
      this.logger.log('Stage 4: Analyzing regime performance...');
      regimeResult = await this.regimeAnalysisService.analyzeRegimes(
        candles,
        trades.map((t) => ({
          entryTime: t.entryTime,
          exitTime: t.exitTime,
          pnl: t.pnl,
          direction: t.direction,
        })),
      );
      regimeStage = this.validateRegime(regimeResult, fullConfig);
    }

    // Stage 5: Sensitivity Analysis
    let sensitivityStage: ValidationStageResult | undefined;
    let sensitivityResult: SensitivityAnalysisResult | undefined;

    if (!fullConfig.skip?.sensitivityAnalysis && parameterSpecs && baseParams) {
      this.logger.log('Stage 5: Running sensitivity analysis...');
      sensitivityResult = await this.sensitivityService.analyzeSensitivity(
        { runBacktest: (params) => dataProvider.runBacktest(params) },
        parameterSpecs,
        baseParams,
        { includePairwise: parameterSpecs.length <= 4 },
      );
      sensitivityStage = this.validateSensitivity(sensitivityResult, fullConfig);
    }

    // Aggregate results
    const stages = {
      metrics: metricsStage,
      walkForward: walkForwardStage,
      stressTest: stressStage,
      regimeAnalysis: regimeStage,
      sensitivity: sensitivityStage,
    };

    const overallScore = this.calculateOverallScore(stages);
    const passed = this.determineOverallPass(stages, fullConfig);
    const deploymentReadiness = this.determineDeploymentReadiness(
      stages,
      overallScore,
    );

    const recommendations = this.aggregateRecommendations(
      metricsResult,
      walkForwardResult,
      stressResult,
      regimeResult,
      sensitivityResult,
    );

    const deploymentChecklist = this.generateDeploymentChecklist(
      stages,
      fullConfig,
    );

    const executiveSummary = this.generateExecutiveSummary(
      fullConfig.strategyName,
      overallScore,
      deploymentReadiness,
      stages,
    );

    return {
      strategyName: fullConfig.strategyName,
      timestamp: new Date(),
      passed,
      overallScore,
      deploymentReadiness,
      stages,
      details: {
        metrics: metricsResult,
        walkForward: walkForwardResult,
        stressTest: stressResult,
        regime: regimeResult,
        sensitivity: sensitivityResult,
      },
      recommendations,
      deploymentChecklist,
      executiveSummary,
    };
  }

  /**
   * Validate basic metrics
   */
  private validateMetrics(
    metrics: ExtendedMetrics,
    config: ValidationPipelineConfig,
  ): ValidationStageResult {
    const warnings: string[] = [];
    const criticalIssues: string[] = [];
    let score = 100;

    // Check Sharpe
    if (metrics.risk.sharpeRatio < config.minSharpe) {
      score -= 30;
      criticalIssues.push(
        `Sharpe ratio ${metrics.risk.sharpeRatio.toFixed(2)} below minimum ${config.minSharpe}`,
      );
    } else if (metrics.risk.sharpeRatio < config.minSharpe * 1.5) {
      score -= 10;
      warnings.push(
        `Sharpe ratio ${metrics.risk.sharpeRatio.toFixed(2)} is marginal`,
      );
    }

    // Check drawdown
    if (metrics.drawdown.maxDrawdownPercent > config.maxDrawdown) {
      score -= 25;
      criticalIssues.push(
        `Max drawdown ${metrics.drawdown.maxDrawdownPercent.toFixed(1)}% exceeds limit ${config.maxDrawdown}%`,
      );
    }

    // Check trade count
    if (metrics.basic.totalTrades < 30) {
      score -= 15;
      warnings.push(
        `Only ${metrics.basic.totalTrades} trades - insufficient sample size`,
      );
    }

    // Check profit factor
    if (metrics.basic.profitFactor < 1.2) {
      score -= 10;
      warnings.push(
        `Profit factor ${metrics.basic.profitFactor.toFixed(2)} is low`,
      );
    }

    // Check for existing warnings
    warnings.push(...metrics.warnings);

    const passed = criticalIssues.length === 0 && score >= 60;

    return {
      stage: 'Basic Metrics',
      passed,
      score: Math.max(0, score),
      details: `Sharpe: ${metrics.risk.sharpeRatio.toFixed(2)}, Max DD: ${metrics.drawdown.maxDrawdownPercent.toFixed(1)}%, PF: ${metrics.basic.profitFactor.toFixed(2)}`,
      warnings,
      criticalIssues,
    };
  }

  /**
   * Validate walk-forward results
   */
  private validateWalkForward(
    result: WalkForwardResult,
    config: ValidationPipelineConfig,
  ): ValidationStageResult {
    const warnings: string[] = [];
    const criticalIssues: string[] = [];
    let score = 100;

    // Check efficiency
    if (result.efficiency.sharpeEfficiency < config.minWalkForwardEfficiency) {
      score -= 30;
      criticalIssues.push(
        `Walk-forward efficiency ${(result.efficiency.sharpeEfficiency * 100).toFixed(0)}% below minimum ${config.minWalkForwardEfficiency * 100}%`,
      );
    }

    // Check consistency
    if (result.statistics.consistencyScore < 50) {
      score -= 20;
      warnings.push(
        `Only ${result.statistics.consistencyScore.toFixed(0)}% of windows profitable OOS`,
      );
    }

    // Check overfitting
    if (result.statistics.overfittingDetected) {
      score -= 25;
      criticalIssues.push('Overfitting detected in walk-forward analysis');
    }

    // Check sample size
    if (result.windows.length < 5) {
      score -= 15;
      warnings.push(
        `Only ${result.windows.length} test windows - may need more data`,
      );
    }

    warnings.push(...result.recommendations.filter((r) => r.includes('CAUTION') || r.includes('NOTE')));

    const passed = criticalIssues.length === 0 && score >= 60;

    return {
      stage: 'Walk-Forward Validation',
      passed,
      score: Math.max(0, score),
      details: `Efficiency: ${(result.efficiency.sharpeEfficiency * 100).toFixed(0)}%, Consistency: ${result.statistics.consistencyScore.toFixed(0)}%`,
      warnings,
      criticalIssues,
    };
  }

  /**
   * Validate stress test results
   */
  private validateStressTest(
    result: StressTestSuite,
    config: ValidationPipelineConfig,
  ): ValidationStageResult {
    const warnings: string[] = [];
    const criticalIssues: string[] = [];
    let score = result.robustnessScore;

    // Check robustness threshold
    if (result.robustnessScore < config.minStressRobustness) {
      criticalIssues.push(
        `Stress robustness ${result.robustnessScore.toFixed(0)} below minimum ${config.minStressRobustness}`,
      );
    }

    // Check ruin probability
    if (result.monteCarlo && result.monteCarlo.ruinProbability > 10) {
      score -= 20;
      criticalIssues.push(
        `${result.monteCarlo.ruinProbability.toFixed(1)}% probability of significant loss`,
      );
    }

    // Check failed scenarios
    const failedScenarios = result.results.filter((r) => !r.passed);
    if (failedScenarios.length > result.results.length * 0.3) {
      score -= 15;
      warnings.push(
        `${failedScenarios.length}/${result.results.length} stress scenarios failed`,
      );
    }

    warnings.push(...result.recommendations.filter((r) => !r.includes('CRITICAL')));

    const passed = criticalIssues.length === 0 && score >= 50;

    return {
      stage: 'Stress Testing',
      passed,
      score: Math.max(0, Math.min(100, score)),
      details: `Robustness: ${result.robustnessScore.toFixed(0)}/100, Passed: ${result.summary.scenariosPassed}/${result.results.length}`,
      warnings,
      criticalIssues,
    };
  }

  /**
   * Validate regime analysis results
   */
  private validateRegime(
    result: RegimeAnalysisResult,
    config: ValidationPipelineConfig,
  ): ValidationStageResult {
    const warnings: string[] = [];
    const criticalIssues: string[] = [];
    let score = 100;

    // Check regime sensitivity
    if (result.strategyCharacter.regimeSensitivity > config.maxRegimeSensitivity) {
      score -= 25;
      warnings.push(
        `High regime sensitivity: ${result.strategyCharacter.regimeSensitivity.toFixed(0)}%`,
      );
    }

    // Check diversity
    if (result.exposure.regimeDiversity < 30) {
      score -= 15;
      warnings.push(
        `Low regime diversity: ${result.exposure.regimeDiversity.toFixed(0)}%`,
      );
    }

    // Check for losing regimes
    const losingTrends = Object.entries(result.byTrend).filter(
      ([_, stats]) => stats.totalPnL < 0 && stats.trades > 5,
    );
    if (losingTrends.length > 0) {
      score -= 10 * losingTrends.length;
      for (const [regime, stats] of losingTrends) {
        warnings.push(
          `Losing in ${regime} regime: ${stats.totalPnL.toFixed(0)} USD over ${stats.trades} trades`,
        );
      }
    }

    warnings.push(...result.recommendations);

    const passed = criticalIssues.length === 0 && score >= 50;

    return {
      stage: 'Regime Analysis',
      passed,
      score: Math.max(0, score),
      details: `Sensitivity: ${result.strategyCharacter.regimeSensitivity.toFixed(0)}%, Best: ${result.strategyCharacter.preferredRegime}`,
      warnings,
      criticalIssues,
    };
  }

  /**
   * Validate sensitivity analysis results
   */
  private validateSensitivity(
    result: SensitivityAnalysisResult,
    config: ValidationPipelineConfig,
  ): ValidationStageResult {
    const warnings: string[] = [];
    const criticalIssues: string[] = [];
    let score = result.robustness.score;

    // Check overfitting risk
    const riskLevels = { low: 0, medium: 1, high: 2 };
    const maxRiskLevel = riskLevels[config.maxOverfittingRisk];
    const actualRiskLevel = riskLevels[result.robustness.overfittingRisk];

    if (actualRiskLevel > maxRiskLevel) {
      score -= 30;
      criticalIssues.push(
        `Overfitting risk (${result.robustness.overfittingRisk}) exceeds acceptable level (${config.maxOverfittingRisk})`,
      );
    }

    // Check stability
    if (result.robustness.avgStability < 50) {
      score -= 20;
      warnings.push(
        `Low parameter stability: ${result.robustness.avgStability.toFixed(0)}%`,
      );
    }

    warnings.push(...result.warnings);

    const passed = criticalIssues.length === 0 && score >= 50;

    return {
      stage: 'Sensitivity Analysis',
      passed,
      score: Math.max(0, score),
      details: `Stability: ${result.robustness.avgStability.toFixed(0)}%, Overfitting: ${result.robustness.overfittingRisk}`,
      warnings,
      criticalIssues,
    };
  }

  /**
   * Calculate overall validation score
   */
  private calculateOverallScore(
    stages: ValidationPipelineResult['stages'],
  ): number {
    const weights = {
      metrics: 0.3,
      walkForward: 0.25,
      stressTest: 0.2,
      regimeAnalysis: 0.15,
      sensitivity: 0.1,
    };

    let totalWeight = 0;
    let weightedScore = 0;

    for (const [key, result] of Object.entries(stages)) {
      if (result) {
        const weight = weights[key as keyof typeof weights] || 0;
        totalWeight += weight;
        weightedScore += result.score * weight;
      }
    }

    return totalWeight > 0 ? weightedScore / totalWeight : 0;
  }

  /**
   * Determine overall pass/fail
   */
  private determineOverallPass(
    stages: ValidationPipelineResult['stages'],
    config: ValidationPipelineConfig,
  ): boolean {
    // Must pass metrics
    if (!stages.metrics.passed) return false;

    // Count critical failures
    const criticalFailures = Object.values(stages).filter(
      (s) => s && !s.passed && s.criticalIssues.length > 0,
    ).length;

    return criticalFailures === 0;
  }

  /**
   * Determine deployment readiness
   */
  private determineDeploymentReadiness(
    stages: ValidationPipelineResult['stages'],
    overallScore: number,
  ): ValidationPipelineResult['deploymentReadiness'] {
    const allPassed = Object.values(stages).every((s) => !s || s.passed);

    if (allPassed && overallScore >= 75) {
      return 'ready';
    } else if (overallScore >= 50) {
      return 'conditional';
    } else {
      return 'not_ready';
    }
  }

  /**
   * Aggregate recommendations from all stages
   */
  private aggregateRecommendations(
    metrics: ExtendedMetrics,
    walkForward?: WalkForwardResult,
    stress?: StressTestSuite,
    regime?: RegimeAnalysisResult,
    sensitivity?: SensitivityAnalysisResult,
  ): ValidationPipelineResult['recommendations'] {
    const critical: string[] = [];
    const important: string[] = [];
    const suggestions: string[] = [];

    // Metrics warnings
    for (const warning of metrics.warnings) {
      if (warning.includes('HIGH') || warning.includes('CRITICAL')) {
        critical.push(warning);
      } else {
        important.push(warning);
      }
    }

    // Walk-forward recommendations
    if (walkForward) {
      for (const rec of walkForward.recommendations) {
        if (rec.includes('WARNING') || rec.includes('ALERT')) {
          critical.push(rec);
        } else if (rec.includes('CAUTION')) {
          important.push(rec);
        } else {
          suggestions.push(rec);
        }
      }
    }

    // Stress test recommendations
    if (stress) {
      for (const rec of stress.recommendations) {
        if (rec.includes('CRITICAL')) {
          critical.push(rec);
        } else if (rec.includes('WARNING')) {
          important.push(rec);
        } else {
          suggestions.push(rec);
        }
      }
    }

    // Regime recommendations
    if (regime) {
      for (const rec of regime.recommendations) {
        if (rec.includes('WARNING')) {
          important.push(rec);
        } else {
          suggestions.push(rec);
        }
      }
    }

    // Sensitivity recommendations
    if (sensitivity) {
      for (const rec of sensitivity.recommendations) {
        if (rec.includes('HIGH OVERFITTING')) {
          critical.push(rec);
        } else if (rec.includes('WARNING') || rec.includes('CAUTION')) {
          important.push(rec);
        } else {
          suggestions.push(rec);
        }
      }
    }

    return {
      critical: [...new Set(critical)],
      important: [...new Set(important)],
      suggestions: [...new Set(suggestions)],
    };
  }

  /**
   * Generate deployment checklist
   */
  private generateDeploymentChecklist(
    stages: ValidationPipelineResult['stages'],
    config: ValidationPipelineConfig,
  ): ValidationPipelineResult['deploymentChecklist'] {
    const checklist: ValidationPipelineResult['deploymentChecklist'] = [];

    // Metrics checks
    checklist.push({
      item: `Sharpe ratio >= ${config.minSharpe}`,
      status: stages.metrics.passed ? 'pass' : 'fail',
      notes: stages.metrics.details,
    });

    checklist.push({
      item: `Max drawdown <= ${config.maxDrawdown}%`,
      status:
        stages.metrics.criticalIssues.some((i) => i.includes('drawdown'))
          ? 'fail'
          : 'pass',
      notes: stages.metrics.details,
    });

    // Walk-forward check
    if (stages.walkForward) {
      checklist.push({
        item: `Walk-forward efficiency >= ${config.minWalkForwardEfficiency * 100}%`,
        status: stages.walkForward.passed ? 'pass' : 'fail',
        notes: stages.walkForward.details,
      });
    }

    // Stress test check
    if (stages.stressTest) {
      checklist.push({
        item: `Stress robustness >= ${config.minStressRobustness}`,
        status: stages.stressTest.passed ? 'pass' : 'fail',
        notes: stages.stressTest.details,
      });
    }

    // Regime check
    if (stages.regimeAnalysis) {
      checklist.push({
        item: `Regime sensitivity <= ${config.maxRegimeSensitivity}%`,
        status: stages.regimeAnalysis.passed ? 'pass' : 'warning',
        notes: stages.regimeAnalysis.details,
      });
    }

    // Sensitivity check
    if (stages.sensitivity) {
      checklist.push({
        item: `Overfitting risk <= ${config.maxOverfittingRisk}`,
        status: stages.sensitivity.passed ? 'pass' : 'fail',
        notes: stages.sensitivity.details,
      });
    }

    return checklist;
  }

  /**
   * Generate executive summary
   */
  private generateExecutiveSummary(
    strategyName: string,
    overallScore: number,
    readiness: ValidationPipelineResult['deploymentReadiness'],
    stages: ValidationPipelineResult['stages'],
  ): string {
    const lines: string[] = [];

    lines.push(`# Validation Report: ${strategyName}`);
    lines.push('');
    lines.push(`**Overall Score:** ${overallScore.toFixed(0)}/100`);
    lines.push(
      `**Deployment Readiness:** ${readiness.toUpperCase().replace('_', ' ')}`,
    );
    lines.push('');

    // Stage summary
    lines.push('## Stage Results');
    for (const [name, result] of Object.entries(stages)) {
      if (result) {
        const icon = result.passed ? '✓' : '✗';
        lines.push(
          `- ${icon} **${result.stage}**: ${result.score.toFixed(0)}/100 - ${result.details}`,
        );
      }
    }
    lines.push('');

    // Critical issues
    const criticalIssues = Object.values(stages)
      .filter((s) => s)
      .flatMap((s) => s!.criticalIssues);

    if (criticalIssues.length > 0) {
      lines.push('## Critical Issues');
      for (const issue of criticalIssues) {
        lines.push(`- ⚠️ ${issue}`);
      }
      lines.push('');
    }

    // Recommendation
    lines.push('## Recommendation');
    if (readiness === 'ready') {
      lines.push(
        'Strategy has passed all validation checks and is ready for paper trading followed by live deployment with appropriate position sizing.',
      );
    } else if (readiness === 'conditional') {
      lines.push(
        'Strategy shows promise but has some concerns. Consider addressing the warnings before deployment, or deploy with reduced position size and enhanced monitoring.',
      );
    } else {
      lines.push(
        'Strategy has failed critical validation checks. Do not deploy until issues are addressed. Review the critical issues above and consider strategy modifications.',
      );
    }

    return lines.join('\n');
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
