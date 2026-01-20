import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { LotteryOrder } from './entities/lottery-order.entity';
import { LotterySelectionHistory } from './entities/lottery-selection-history.entity';
import { LotteryPerformance } from './entities/lottery-performance.entity';

import { LotteryFilterService } from './lottery-filter.service';
import { SymbolSelectorService } from './symbol-selector.service';
import { EntryCalculatorService } from './entry-calculator.service';
import { LotteryExecutorService } from './lottery-executor.service';
import { LotteryWebSocketHandler } from './websocket-handler.service';
import { VolumeProviderService } from './volume-provider.service';

// Import DualStrategyModule to access shared services (using forwardRef to avoid circular dependency)
import { DualStrategyModule } from '../dual-strategy/dual-strategy.module';
import { WebSocketModule } from '../websocket/websocket.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LotteryOrder,
      LotterySelectionHistory,
      LotteryPerformance,
    ]),
    ScheduleModule.forRoot(),
    forwardRef(() => DualStrategyModule),
    WebSocketModule,
  ],
  providers: [
    // Lottery services
    LotteryFilterService,
    SymbolSelectorService,
    EntryCalculatorService,
    LotteryExecutorService,
    LotteryWebSocketHandler,
    VolumeProviderService,
  ],
  exports: [
    LotteryExecutorService,
  ]
})
export class LotteryModule {}
