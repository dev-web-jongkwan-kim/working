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

// Execution
import { OrderExecutorService } from './services/execution/order-executor.service';
import { PositionManagerService } from './services/execution/position-manager.service';
import { RiskManagerService } from './services/execution/risk-manager.service';
import { PositionReconcilerService } from './services/execution/position-reconciler.service';
import { SignalQueueService } from './services/execution/signal-queue.service';

// Orchestrator (legacy - kept for backwards compatibility with existing API)
import { DualStrategyOrchestratorService } from './services/orchestrator/dual-strategy-orchestrator.service';

// Controller
import { DualStrategyController } from './controllers/dual-strategy.controller';

// WebSocket
import { WebSocketModule } from '../websocket/websocket.module';

// Lottery
import { LotteryModule } from '../lottery/lottery.module';

// NEW: Strategies Module (v2 - Core Trend, Squeeze)
import { StrategiesModule } from '../strategies/strategies.module';

// NEW: Live Data Adapter
import { LiveDataAdapterAsync } from '../adapters/live/live-data-adapter';

/**
 * Dual Strategy Module
 *
 * Note: Legacy strategies (CYCLE_RIDER, HOUR_SWING, BOX_RANGE) have been removed.
 * Use UnifiedModule with CoreTrendStrategy and SqueezeStrategy instead.
 *
 * This module is kept for:
 * - Data collection services
 * - Execution services (order execution, position management, risk management)
 * - Regime classification
 * - Backwards compatibility with existing API endpoints
 */
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
    StrategiesModule,
  ],
  providers: [
    // Data services
    DataCacheService,
    DataCollectorService,
    SymbolFetcherService,
    ExchangeInfoService,
    RateLimiterService,
    UserDataStreamService,
    BinanceService,

    // Regime
    MarketRegimeClassifierService,

    // Execution
    OrderExecutorService,
    PositionManagerService,
    RiskManagerService,
    PositionReconcilerService,
    SignalQueueService,

    // Orchestrator (legacy - kept for API compatibility)
    DualStrategyOrchestratorService,

    // Live Data Adapter
    LiveDataAdapterAsync,
  ],
  controllers: [DualStrategyController],
  exports: [
    // Data services
    DataCacheService,
    DataCollectorService,
    SymbolFetcherService,
    ExchangeInfoService,
    BinanceService,

    // Regime
    MarketRegimeClassifierService,

    // Execution services (used by UnifiedModule)
    OrderExecutorService,
    PositionManagerService,
    RiskManagerService,

    // Orchestrator (legacy)
    DualStrategyOrchestratorService,

    // Live Data Adapter
    LiveDataAdapterAsync,
  ],
})
export class DualStrategyModule {}
