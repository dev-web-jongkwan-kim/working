import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CustomLoggerService } from './custom-logger.service';
import { StrategyLog } from '../../entities/strategy-log.entity';
import { SystemLog } from '../../entities/system-log.entity';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([StrategyLog, SystemLog]),
  ],
  providers: [CustomLoggerService],
  exports: [CustomLoggerService],
})
export class LoggingModule {}
