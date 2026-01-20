import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { CustomLoggerService } from '../common/logging/custom-logger.service';

export interface PositionUpdateEvent {
  positionId: string;
  symbol: string;
  currentPrice?: number;
  unrealizedPnl?: number;
  unrealizedPnlPercent?: number;
  remainingSize?: number;
  realizedPnl?: number;
  tp1Filled?: boolean;
  tp2Filled?: boolean;
}

export interface PositionClosedEvent {
  positionId: string;
  symbol: string;
  closeReason: string;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
}

export interface TradeUpdateEvent {
  tradeId: string;
  symbol?: string;
  status: string;
  exitPrice?: number;
  pnl?: number;
  pnlPercent?: number;
  closeReason?: string;
}

export interface NewTradeEvent {
  tradeId: string;
  strategyType: string;
  subStrategy: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  leverage: number;
  marginUsd: number;
}

export interface LotteryOrderEvent {
  orderId: string;
  symbol: string;
  entryPrice: number;
  lotteryScore: number;
  status: string;
  margin: number;
  leverage: number;
  stopLossPrice: number;
}

export interface LotteryOrderUpdateEvent {
  orderId: string;
  status: string;
  filledAt?: Date;
  pnl?: number;
  pnlPct?: number;
}

/**
 * WebSocket Gateway for real-time updates to frontend
 */
@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
})
export class TradingWebSocketGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private readonly logger: CustomLoggerService) {}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway initialized', 'WebSocketGateway');
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`, 'WebSocketGateway');
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`, 'WebSocketGateway');
  }

  /**
   * Emit position update to all connected clients
   */
  emitPositionUpdate(data: PositionUpdateEvent) {
    this.server.emit('position:update', data);
  }

  /**
   * Emit trade update to all connected clients
   */
  emitTradeUpdate(data: TradeUpdateEvent) {
    this.server.emit('trade:update', data);
  }

  /**
   * Emit new trade to all connected clients
   */
  emitNewTrade(data: NewTradeEvent) {
    this.server.emit('trade:new', data);
  }

  /**
   * Emit trade closed to all connected clients
   */
  emitTradeClosed(data: TradeUpdateEvent) {
    this.server.emit('trade:closed', data);
  }

  /**
   * Emit system alert
   */
  emitSystemAlert(message: string, level: 'info' | 'warning' | 'error') {
    this.server.emit('system:alert', { message, level, timestamp: new Date() });
  }

  /**
   * Emit market regime change
   */
  emitMarketRegimeChange(regime: string) {
    this.server.emit('market:regime', { regime, timestamp: new Date() });
  }

  /**
   * Emit position closed event (for TP/SL fills from User Data Stream)
   */
  emitPositionClosed(data: PositionClosedEvent) {
    this.server.emit('position:closed', data);
  }

  /**
   * Emit margin call alert (CRITICAL)
   */
  emitMarginCall(data: any) {
    this.server.emit('margin:call', {
      ...data,
      timestamp: new Date(),
      severity: 'CRITICAL',
    });
    // Also emit as system alert
    this.emitSystemAlert('⚠️ MARGIN CALL RECEIVED! Check positions immediately!', 'error');
  }

  /**
   * Emit new lottery order placed
   */
  emitNewLotteryOrder(data: LotteryOrderEvent) {
    this.server.emit('lottery:new', data);
  }

  /**
   * Emit lottery order update (filled, cancelled, closed)
   */
  emitLotteryOrderUpdate(data: LotteryOrderUpdateEvent) {
    this.server.emit('lottery:update', data);
  }

  /**
   * Emit lottery order filled
   */
  emitLotteryOrderFilled(data: LotteryOrderUpdateEvent) {
    this.server.emit('lottery:filled', data);
  }

  /**
   * Emit lottery order closed
   */
  emitLotteryOrderClosed(data: LotteryOrderUpdateEvent) {
    this.server.emit('lottery:closed', data);
  }
}
