/**
 * Backtest Module Exports
 *
 * Public API for the backtest module including:
 * - Execution model (realistic trade simulation)
 * - Extended metrics calculation
 * - Walk-forward validation
 * - Stress testing
 * - Regime analysis
 * - Parameter sensitivity analysis
 * - Unified validation pipeline
 */

// Models
export * from './models/execution-model';

// Services
export { MetricsCalculatorService } from './services/metrics-calculator.service';
export type {
  ExtendedMetrics,
  BasicMetrics,
  RiskMetrics,
  DrawdownMetrics,
  StreakMetrics,
  TimeMetrics,
} from './services/metrics-calculator.service';

export { WalkForwardService } from './services/walk-forward.service';
export type {
  WalkForwardConfig,
  WalkForwardResult,
  WindowResult,
  ParameterRange,
} from './services/walk-forward.service';

export { StressTestService } from './services/stress-test.service';
export type {
  StressScenario,
  StressTestResult,
  StressTestSuite,
  MonteCarloResult,
  TradeInput,
} from './services/stress-test.service';

export { RegimeAnalysisService } from './services/regime-analysis.service';
export type {
  RegimeAnalysisResult,
  RegimePeriod,
  RegimePerformance,
  CandleData,
  TradeData,
} from './services/regime-analysis.service';
export { TrendRegime, VolatilityRegime, MarketStructure } from './services/regime-analysis.service';

export { SensitivityAnalysisService } from './services/sensitivity-analysis.service';
export type {
  ParameterSpec,
  ParameterSensitivity,
  PairwiseSensitivity,
  SensitivityAnalysisResult,
} from './services/sensitivity-analysis.service';

export { ValidationPipelineService } from './services/validation-pipeline.service';
export type {
  ValidationPipelineConfig,
  ValidationPipelineResult,
  ValidationStageResult,
  BacktestDataProvider,
} from './services/validation-pipeline.service';

// Module
export { BacktestModule } from './backtest.module';
