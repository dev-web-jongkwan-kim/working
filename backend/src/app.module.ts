import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from './common/database/database.module';
import { LoggingModule } from './common/logging/logging.module';
import { DualStrategyModule } from './dual-strategy/dual-strategy.module';
import { LotteryModule } from './lottery/lottery.module';
import { WebSocketModule } from './websocket/websocket.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Schedule for cron jobs
    ScheduleModule.forRoot(),

    // Event emitter for real-time reactions
    EventEmitterModule.forRoot(),

    // Database
    DatabaseModule,

    // Logging
    LoggingModule,

    // Feature modules
    DualStrategyModule,
    LotteryModule,
    WebSocketModule,
    ApiModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
