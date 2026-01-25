import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository, In } from 'typeorm';
import { LotteryOrder } from '../../lottery/entities/lottery-order.entity';
import { LotterySelectionHistory } from '../../lottery/entities/lottery-selection-history.entity';
import { LotteryPerformance } from '../../lottery/entities/lottery-performance.entity';
import * as crypto from 'crypto';

@Injectable()
export class LotteryService {
  private readonly logger = new Logger(LotteryService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;

  constructor(
    @InjectRepository(LotteryOrder)
    private readonly orderRepo: Repository<LotteryOrder>,
    @InjectRepository(LotterySelectionHistory)
    private readonly historyRepo: Repository<LotterySelectionHistory>,
    @InjectRepository(LotteryPerformance)
    private readonly performanceRepo: Repository<LotteryPerformance>,
    private readonly configService: ConfigService,
  ) {
    this.apiKey = this.configService.get('BINANCE_API_KEY');
    this.apiSecret = this.configService.get('BINANCE_SECRET_KEY');
    this.baseUrl = this.configService.get('BINANCE_TESTNET') === 'true'
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  /**
   * Get active lottery orders (PENDING or FILLED)
   */
  async getActiveOrders(): Promise<LotteryOrder[]> {
    return this.orderRepo.find({
      where: [{ status: 'PENDING' }, { status: 'FILLED' }],
      order: { created_at: 'DESC' },
    });
  }

  /**
   * Get closed lottery orders (CANCELLED or CLOSED)
   */
  async getClosedOrders(limit: number): Promise<LotteryOrder[]> {
    return this.orderRepo.find({
      where: [{ status: 'CANCELLED' }, { status: 'CLOSED' }],
      order: { created_at: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get performance summary
   */
  async getPerformanceSummary() {
    const allOrders = await this.orderRepo.find();
    const closedOrders = allOrders.filter((o) => o.status === 'CLOSED');

    const totalTrades = closedOrders.length;
    const winningTrades = closedOrders.filter((o) => parseFloat(o.pnl as any) > 0).length;
    const totalPnl = closedOrders.reduce((sum, o) => sum + parseFloat(o.pnl as any || '0'), 0);
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

    const wins = closedOrders.filter((o) => parseFloat(o.pnl as any) > 0);
    const losses = closedOrders.filter((o) => parseFloat(o.pnl as any) < 0);

    const grossProfit = wins.reduce((sum, o) => sum + parseFloat(o.pnl as any), 0);
    const grossLoss = Math.abs(losses.reduce((sum, o) => sum + parseFloat(o.pnl as any), 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    return {
      totalTrades,
      winningTrades,
      losingTrades: totalTrades - winningTrades,
      winRate,
      totalPnl,
      profitFactor,
      activeOrders: await this.orderRepo.count({
        where: [{ status: 'PENDING' }, { status: 'FILLED' }],
      }),
    };
  }

  /**
   * Get selection history
   */
  async getSelectionHistory(limit: number): Promise<LotterySelectionHistory[]> {
    return this.historyRepo.find({
      order: { execution_time: 'DESC' },
      take: limit,
    });
  }

  /**
   * Sync PENDING orders with Binance
   * Check if orders still exist on Binance and update DB accordingly
   */
  async syncWithBinance(): Promise<{ synced: number; cancelled: number; errors: string[] }> {
    const pendingOrders = await this.orderRepo.find({
      where: { status: 'PENDING' },
    });

    this.logger.log(`[Sync] Checking ${pendingOrders.length} PENDING orders with Binance...`);

    let synced = 0;
    let cancelled = 0;
    const errors: string[] = [];

    for (const order of pendingOrders) {
      try {
        const binanceOrder = await this.getOrderFromBinance(order.symbol, order.binance_order_id);

        if (!binanceOrder) {
          // Order doesn't exist on Binance - mark as CANCELLED
          this.logger.warn(`[Sync] Order ${order.symbol} (${order.binance_order_id}) not found on Binance. Marking as CANCELLED.`);
          order.status = 'CANCELLED';
          await this.orderRepo.save(order);
          cancelled++;
        } else if (binanceOrder.status === 'CANCELED' || binanceOrder.status === 'EXPIRED') {
          // Order was cancelled/expired on Binance
          this.logger.log(`[Sync] Order ${order.symbol} status on Binance: ${binanceOrder.status}. Updating DB.`);
          order.status = 'CANCELLED';
          await this.orderRepo.save(order);
          cancelled++;
        } else if (binanceOrder.status === 'FILLED') {
          // Order was filled - update status
          this.logger.log(`[Sync] Order ${order.symbol} was FILLED on Binance. Updating DB.`);
          order.status = 'FILLED';
          order.filled_at = new Date(binanceOrder.updateTime);
          await this.orderRepo.save(order);
          synced++;
        } else {
          // Order still active (NEW, PARTIALLY_FILLED)
          this.logger.log(`[Sync] Order ${order.symbol} still ${binanceOrder.status} on Binance.`);
          synced++;
        }
      } catch (error) {
        const errorMsg = `Failed to sync ${order.symbol}: ${error.message}`;
        this.logger.error(`[Sync] ${errorMsg}`);
        errors.push(errorMsg);
      }
    }

    this.logger.log(`[Sync] Complete. Synced: ${synced}, Cancelled: ${cancelled}, Errors: ${errors.length}`);
    return { synced, cancelled, errors };
  }

  /**
   * Get order status from Binance
   */
  private async getOrderFromBinance(symbol: string, orderId: number): Promise<any> {
    try {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol,
        orderId: orderId.toString(),
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      const response = await fetch(`${this.baseUrl}/fapi/v1/order?${params.toString()}`, {
        method: 'GET',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (errorData.code === -2013) {
          // Order does not exist
          return null;
        }
        throw new Error(errorData.msg || `HTTP ${response.status}`);
      }

      return response.json();
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create HMAC signature for Binance API
   */
  private createSignature(queryString: string): string {
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }
}
