import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trade } from '../entities/trade.entity';
import { Position } from '../entities/position.entity';
import { Signal } from '../entities/signal.entity';
import { StrategyLog } from '../entities/strategy-log.entity';
import { MarketRegimeHistory } from '../entities/market-regime-history.entity';
import { RiskEvent } from '../entities/risk-event.entity';

// Data services
import { DataCacheService } from './services/data/data-cache.service';
import { DataCollectorService } from './services/data/data-collector.service';
import { SymbolFetcherService } from './services/data/symbol-fetcher.service';
import { ExchangeInfoService } from './services/data/exchange-info.service';
import { RateLimiterService } from './services/data/rate-limiter.service';
import { UserDataStreamService } from './services/data/user-data-stream.service';
import { BinanceService } from './services/data/binance.service';

// Regime
import { MarketRegimeClassifierService } from './services/regime/market-regime-classifier.service';

// Strategy A - Cycle Rider
import { AccumulationDetectorService } from './services/cycle-rider/accumulation-detector.service';
import { DistributionDetectorService } from './services/cycle-rider/distribution-detector.service';
import { DivergenceAnalyzerService } from './services/cycle-rider/divergence-analyzer.service';
import { VolumeClimaxDetectorService } from './services/cycle-rider/volume-climax-detector.service';
import { SqueezeDetectorService } from './services/cycle-rider/squeeze-detector.service';
import { CycleRiderSignalService } from './services/cycle-rider/cycle-rider-signal.service';

// Strategy B - Hour Swing
import { MtfAlignmentAnalyzerService } from './services/hour-swing/mtf-alignment-analyzer.service';
import { RelativeStrengthRankerService } from './services/hour-swing/relative-strength-ranker.service';
import { FundingExtremesDetectorService } from './services/hour-swing/funding-extremes-detector.service';
import { HourSwingSignalService } from './services/hour-swing/hour-swing-signal.service';

// Strategy C - Box Range
import { BoxDetectorService } from './services/box-range/box-detector.service';
import { BoxEntryAnalyzerService } from './services/box-range/box-entry-analyzer.service';
import { BoxRangeSignalService } from './services/box-range/box-range-signal.service';
import { BoxBreakoutMonitorService } from './services/box-range/box-breakout-monitor.service';

// Execution
import { OrderExecutorService } from './services/execution/order-executor.service';
import { PositionManagerService } from './services/execution/position-manager.service';
import { RiskManagerService } from './services/execution/risk-manager.service';
import { PositionReconcilerService } from './services/execution/position-reconciler.service';
import { SignalQueueService } from './services/execution/signal-queue.service';

// Orchestrator
import { DualStrategyOrchestratorService } from './services/orchestrator/dual-strategy-orchestrator.service';

// Controller
import { DualStrategyController } from './controllers/dual-strategy.controller';

// WebSocket
import { WebSocketModule } from '../websocket/websocket.module';

// Lottery
import { LotteryModule } from '../lottery/lottery.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trade,
      Position,
      Signal,
      StrategyLog,
      MarketRegimeHistory,
      RiskEvent,
    ]),
    WebSocketModule,
    forwardRef(() => LotteryModule),
  ],
  providers: [
    // Data
    DataCacheService,
    DataCollectorService,
    SymbolFetcherService,
    ExchangeInfoService,
    RateLimiterService,
    UserDataStreamService,
    BinanceService,

    // Regime
    MarketRegimeClassifierService,

    // Strategy A
    AccumulationDetectorService,
    DistributionDetectorService,
    DivergenceAnalyzerService,
    VolumeClimaxDetectorService,
    SqueezeDetectorService,
    CycleRiderSignalService,

    // Strategy B
    MtfAlignmentAnalyzerService,
    RelativeStrengthRankerService,
    FundingExtremesDetectorService,
    HourSwingSignalService,

    // Strategy C
    BoxDetectorService,
    BoxEntryAnalyzerService,
    BoxRangeSignalService,
    BoxBreakoutMonitorService,

    // Execution
    OrderExecutorService,
    PositionManagerService,
    RiskManagerService,
    PositionReconcilerService,
    SignalQueueService,

    // Orchestrator
    DualStrategyOrchestratorService,
  ],
  controllers: [DualStrategyController],
  exports: [
    DualStrategyOrchestratorService,
    BinanceService,
    SymbolFetcherService,
    ExchangeInfoService,
  ],
})
export class DualStrategyModule {}
