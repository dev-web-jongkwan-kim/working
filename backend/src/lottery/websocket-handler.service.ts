import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LotteryOrder } from './entities/lottery-order.entity';
import { LotteryExecutorService } from './lottery-executor.service';
import { BinanceService } from '../dual-strategy/services/data/binance.service';
import { TradingWebSocketGateway } from '../websocket/websocket.gateway';

@Injectable()
export class LotteryWebSocketHandler implements OnModuleInit {
  private readonly logger = new Logger(LotteryWebSocketHandler.name);
  private readonly POSITION_MARGIN = 30;

  constructor(
    @InjectRepository(LotteryOrder)
    private readonly orderRepo: Repository<LotteryOrder>,
    private readonly lotteryExecutor: LotteryExecutorService,
    private readonly binanceService: BinanceService,
    @Inject(forwardRef(() => TradingWebSocketGateway))
    private readonly wsGateway: TradingWebSocketGateway,
  ) {}

  /**
   * Subscribe to user data stream on init
   */
  async onModuleInit() {
    await this.subscribeUserDataStream();
  }

  /**
   * Subscribe to Binance user data stream
   */
  private async subscribeUserDataStream() {
    try {
      const listenKey = await this.binanceService.getFuturesListenKey();

      this.binanceService.futuresUserDataStream(listenKey, (data) => {
        this.handleUserData(data);
      });

      // Keep alive every 30 minutes
      setInterval(async () => {
        await this.binanceService.keepAliveFuturesListenKey(listenKey);
      }, 30 * 60 * 1000);

      this.logger.log('User data stream subscribed');

    } catch (error) {
      this.logger.error(`Failed to subscribe to user data: ${error.message}`);
    }
  }

  /**
   * Handle user data events
   */
  private async handleUserData(data: any) {
    if (data.eventType === 'ORDER_TRADE_UPDATE') {
      const orderUpdate = data.order;

      // Find lottery order
      const lotteryOrder = await this.orderRepo.findOne({
        where: { binance_order_id: orderUpdate.orderId }
      });

      if (!lotteryOrder) return; // Not a lottery order

      // Handle fill
      if (orderUpdate.orderStatus === 'FILLED') {
        await this.lotteryExecutor.onOrderFilled(
          orderUpdate.orderId,
          parseFloat(orderUpdate.averagePrice)
        );
      }

      // Handle stop loss hit
      if (
        orderUpdate.orderStatus === 'FILLED' &&
        orderUpdate.orderId === lotteryOrder.stop_loss_order_id
      ) {
        await this.handleStopLossHit(lotteryOrder);
      }
    }
  }

  /**
   * Handle stop loss hit
   */
  private async handleStopLossHit(order: LotteryOrder) {
    this.logger.warn(`🛑 Stop Loss hit: ${order.symbol}`);

    const pnl = -this.POSITION_MARGIN * 0.03; // -3%

    order.status = 'CLOSED';
    order.closed_at = new Date();
    order.pnl = pnl;
    order.pnl_pct = -3.0;

    await this.orderRepo.save(order);

    // Emit WebSocket event
    this.wsGateway.emitLotteryOrderClosed({
      orderId: order.order_id,
      status: 'CLOSED',
      pnl: order.pnl,
      pnlPct: order.pnl_pct,
    });

    // Notification
    await this.sendNotification({
      title: '🛑 Stop Loss Hit',
      message: `${order.symbol} stopped out at -3%`,
      priority: 'NORMAL'
    });

    // Refill orders
    await this.lotteryExecutor.ensureOrdersExist();
  }

  private async sendNotification(notification: any) {
    this.logger.log(`[NOTIFICATION] ${notification.title}: ${notification.message}`);
  }
}
