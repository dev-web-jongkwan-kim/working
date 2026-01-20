import { Module } from '@nestjs/common';
import { TradingWebSocketGateway } from './websocket.gateway';
import { LoggingModule } from '../common/logging/logging.module';

@Module({
  imports: [LoggingModule],
  providers: [TradingWebSocketGateway],
  exports: [TradingWebSocketGateway],
})
export class WebSocketModule {}
