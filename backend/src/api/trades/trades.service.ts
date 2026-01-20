import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Trade, TradeStatus } from '../../entities/trade.entity';

@Injectable()
export class TradesService {
  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
  ) {}

  /**
   * Get all trades with pagination
   */
  async getAllTrades(page: number = 1, limit: number = 50): Promise<{
    trades: Trade[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;

    const [trades, total] = await this.tradeRepo.findAndCount({
      order: { entry_time: 'DESC' },
      take: limit,
      skip,
    });

    return {
      trades,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get active trades
   */
  async getActiveTrades(): Promise<Trade[]> {
    return await this.tradeRepo.find({
      where: { status: TradeStatus.OPEN },
      order: { entry_time: 'DESC' },
    });
  }

  /**
   * Get closed trades
   */
  async getClosedTrades(limit: number = 50): Promise<Trade[]> {
    return await this.tradeRepo.find({
      where: { status: TradeStatus.CLOSED },
      order: { exit_time: 'DESC' },
      take: limit,
    });
  }

  /**
   * Get trade by ID
   */
  async getTradeById(tradeId: string): Promise<Trade | null> {
    return await this.tradeRepo.findOne({
      where: { trade_id: tradeId },
    });
  }

  /**
   * Get trades by strategy
   */
  async getTradesByStrategy(strategyType: string): Promise<Trade[]> {
    return await this.tradeRepo.find({
      where: { strategy_type: strategyType as any },
      order: { entry_time: 'DESC' },
    });
  }

  /**
   * Get trades by symbol
   */
  async getTradesBySymbol(symbol: string): Promise<Trade[]> {
    return await this.tradeRepo.find({
      where: { symbol },
      order: { entry_time: 'DESC' },
    });
  }

  /**
   * Get today's trades
   */
  async getTodayTrades(): Promise<Trade[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    return await this.tradeRepo.find({
      where: {
        entry_time: Between(today, tomorrow),
      },
      order: { entry_time: 'DESC' },
    });
  }

  /**
   * Get performance summary
   */
  async getPerformanceSummary(): Promise<{
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
  }> {
    const closedTrades = await this.tradeRepo.find({
      where: { status: TradeStatus.CLOSED },
    });

    const totalTrades = closedTrades.length;
    const winningTrades = closedTrades.filter((t) => Number(t.pnl_usd) > 0);
    const losingTrades = closedTrades.filter((t) => Number(t.pnl_usd) < 0);

    const totalPnl = closedTrades.reduce((sum, t) => sum + Number(t.pnl_usd), 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + Number(t.pnl_usd), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + Number(t.pnl_usd), 0));

    return {
      totalTrades,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0,
      totalPnl,
      avgWin: winningTrades.length > 0 ? grossProfit / winningTrades.length : 0,
      avgLoss: losingTrades.length > 0 ? grossLoss / losingTrades.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
    };
  }
}
