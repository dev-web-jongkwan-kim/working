import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { LotteryOrder } from '../../lottery/entities/lottery-order.entity';
import { LotterySelectionHistory } from '../../lottery/entities/lottery-selection-history.entity';
import { LotteryPerformance } from '../../lottery/entities/lottery-performance.entity';

@Injectable()
export class LotteryService {
  constructor(
    @InjectRepository(LotteryOrder)
    private readonly orderRepo: Repository<LotteryOrder>,
    @InjectRepository(LotterySelectionHistory)
    private readonly historyRepo: Repository<LotterySelectionHistory>,
    @InjectRepository(LotteryPerformance)
    private readonly performanceRepo: Repository<LotteryPerformance>,
  ) {}

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
}
