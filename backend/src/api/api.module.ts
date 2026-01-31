import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trade } from '../entities/trade.entity';
import { Position } from '../entities/position.entity';
import { DailyPerformance } from '../entities/daily-performance.entity';
import { StrategyLog } from '../entities/strategy-log.entity';
import { LotteryOrder } from '../lottery/entities/lottery-order.entity';
import { LotterySelectionHistory } from '../lottery/entities/lottery-selection-history.entity';
import { LotteryPerformance } from '../lottery/entities/lottery-performance.entity';
import { ManualTrade } from '../entities/manual-trade.entity';

// Controllers and Services
import { TradesController } from './trades/trades.controller';
import { TradesService } from './trades/trades.service';
import { PositionsController } from './positions/positions.controller';
import { AnalyticsController } from './analytics/analytics.controller';
import { SystemController } from './system/system.controller';
import { LotteryController } from './lottery/lottery.controller';
import { LotteryService } from './lottery/lottery.service';
import { ManualTradingController } from './manual-trading/manual-trading.controller';
import { ManualTradingService } from './manual-trading/manual-trading.service';
import { DualStrategyModule } from '../dual-strategy/dual-strategy.module';
import { LotteryModule } from '../lottery/lottery.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Trade,
      Position,
      DailyPerformance,
      StrategyLog,
      LotteryOrder,
      LotterySelectionHistory,
      LotteryPerformance,
      ManualTrade,
    ]),
    DualStrategyModule,
    LotteryModule,
  ],
  controllers: [
    TradesController,
    PositionsController,
    AnalyticsController,
    SystemController,
    LotteryController,
    ManualTradingController,
  ],
  providers: [TradesService, LotteryService, ManualTradingService],
})
export class ApiModule {}
