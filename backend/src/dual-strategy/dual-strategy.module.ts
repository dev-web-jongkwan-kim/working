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

// Controller
import { DualStrategyController } from './controllers/dual-strategy.controller';

// WebSocket
import { WebSocketModule } from '../websocket/websocket.module';

// Strategies Module (Core Trend, Squeeze)
import { StrategiesModule } from '../strategies/strategies.module';

// Unified Module (UnifiedOrchestratorService)
import { UnifiedModule } from '../unified/unified.module';

// Live Data Adapter
import { LiveDataAdapterAsync } from '../adapters/live/live-data-adapter';

/**
 * Dual Strategy Module
 *
 * Provides:
 * - Data collection services (Redis caching, Binance WebSocket)
 * - Execution services (order execution, position management, risk management)
 * - Regime classification
 * - API endpoints for trading system control
 *
 * Strategies: Core Trend (4H) + Squeeze (15m) via UnifiedOrchestratorService
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
    StrategiesModule,
    forwardRef(() => UnifiedModule),
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

    // Execution services
    OrderExecutorService,
    PositionManagerService,
    RiskManagerService,

    // Live Data Adapter
    LiveDataAdapterAsync,
  ],
})
export class DualStrategyModule {}
