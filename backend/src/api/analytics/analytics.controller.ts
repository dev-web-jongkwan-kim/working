import { Controller, Get, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Trade, TradeStatus } from '../../entities/trade.entity';
import { DailyPerformance } from '../../entities/daily-performance.entity';
import { StrategyLog } from '../../entities/strategy-log.entity';

@Controller('api/analytics')
export class AnalyticsController {
  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(DailyPerformance)
    private readonly dailyPerfRepo: Repository<DailyPerformance>,
    @InjectRepository(StrategyLog)
    private readonly strategyLogRepo: Repository<StrategyLog>,
  ) {}

  @Get('daily-performance')
  async getDailyPerformance(@Query('days') days?: string) {
    const daysToFetch = days ? parseInt(days) : 30;

    return await this.dailyPerfRepo.find({
      order: { date: 'DESC' },
      take: daysToFetch,
    });
  }

  @Get('pnl-chart')
  async getPnlChart(@Query('days') days?: string) {
    const daysToFetch = days ? parseInt(days) : 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysToFetch);

    const trades = await this.tradeRepo.find({
      where: {
        status: TradeStatus.CLOSED,
        exit_time: Between(startDate, new Date()),
      },
      order: { exit_time: 'ASC' },
    });

    let cumulativePnl = 0;
    const chartData = trades.map((trade) => {
      cumulativePnl += Number(trade.pnl_usd);
      return {
        date: trade.exit_time,
        pnl: Number(trade.pnl_usd),
        cumulativePnl,
      };
    });

    return chartData;
  }

  @Get('strategy-breakdown')
  async getStrategyBreakdown() {
    const trades = await this.tradeRepo.find({
      where: { status: TradeStatus.CLOSED },
    });

    const cycleRider = trades.filter((t) => t.strategy_type === 'CYCLE_RIDER');
    const hourSwing = trades.filter((t) => t.strategy_type === 'HOUR_SWING');

    return {
      cycleRider: {
        trades: cycleRider.length,
        totalPnl: cycleRider.reduce((sum, t) => sum + Number(t.pnl_usd), 0),
        winRate:
          cycleRider.length > 0
            ? (cycleRider.filter((t) => Number(t.pnl_usd) > 0).length / cycleRider.length) * 100
            : 0,
      },
      hourSwing: {
        trades: hourSwing.length,
        totalPnl: hourSwing.reduce((sum, t) => sum + Number(t.pnl_usd), 0),
        winRate:
          hourSwing.length > 0
            ? (hourSwing.filter((t) => Number(t.pnl_usd) > 0).length / hourSwing.length) * 100
            : 0,
      },
    };
  }

  @Get('logs')
  async getRecentLogs(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit) : 100;

    return await this.strategyLogRepo.find({
      order: { created_at: 'DESC' },
      take: limitNum,
    });
  }
}
