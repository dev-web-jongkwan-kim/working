import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { BacktestEngineService } from './services/backtest-engine.service';
import { BinanceDataDownloaderService } from './services/binance-data-downloader.service';
import { BacktestDataCacheService } from './services/backtest-data-cache.service';
import { MetricsCalculatorService } from './services/metrics-calculator.service';
import { WalkForwardService } from './services/walk-forward.service';
import { StressTestService } from './services/stress-test.service';
import { RegimeAnalysisService } from './services/regime-analysis.service';
import { SensitivityAnalysisService } from './services/sensitivity-analysis.service';
import { ValidationPipelineService } from './services/validation-pipeline.service';
import { BacktestRun } from './entities/backtest-run.entity';
import { BacktestTrade } from './entities/backtest-trade.entity';
import { DualStrategyModule } from '../dual-strategy/dual-strategy.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([BacktestRun, BacktestTrade]),
    DualStrategyModule,
  ],
  controllers: [BacktestController],
  providers: [
    BacktestService,
    BacktestEngineService,
    BinanceDataDownloaderService,
    BacktestDataCacheService,
    // Validation & Analysis Services
    MetricsCalculatorService,
    WalkForwardService,
    StressTestService,
    RegimeAnalysisService,
    SensitivityAnalysisService,
    ValidationPipelineService,
  ],
  exports: [
    BacktestService,
    MetricsCalculatorService,
    WalkForwardService,
    StressTestService,
    RegimeAnalysisService,
    SensitivityAnalysisService,
    ValidationPipelineService,
  ],
})
export class BacktestModule {}
