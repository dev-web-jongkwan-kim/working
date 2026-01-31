/**
 * Unified Module
 *
 * Module for the unified strategy orchestrator that uses:
 * - CoreTrendStrategy (4H trigger)
 * - SqueezeStrategy (15m trigger)
 * - Unified PositionStateMachine
 * - LiveActionExecutor for real order execution
 *
 * This module ensures 100% logic consistency between live trading and backtesting.
 */

import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Trade } from '../entities/trade.entity';
import { Position } from '../entities/position.entity';

// Orchestrator
import { UnifiedOrchestratorService } from './orchestrator/unified-orchestrator.service';

// Action Executor
import { LiveActionExecutor } from '../strategies/core/execution/live-action-executor';

// Dependencies from other modules
import { DualStrategyModule } from '../dual-strategy/dual-strategy.module';
import { StrategiesModule } from '../strategies/strategies.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Trade, Position]),
    forwardRef(() => DualStrategyModule),
    StrategiesModule,
  ],
  providers: [
    UnifiedOrchestratorService,
    LiveActionExecutor,
  ],
  exports: [
    UnifiedOrchestratorService,
    LiveActionExecutor,
  ],
})
export class UnifiedModule {}
