import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BacktestRun, BacktestStatus } from './entities/backtest-run.entity';
import { BacktestTrade, TradeStatus } from './entities/backtest-trade.entity';
import { BacktestEngineService } from './services/backtest-engine.service';
import { CustomLoggerService } from '../common/logging/custom-logger.service';

interface CreateBacktestDto {
  name: string;
  symbols: string[];
  strategies: string[];
  startDate: string;
  endDate: string;
  initialBalance: number;
}

@Injectable()
export class BacktestService {
  private readonly availableSymbols = [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'ADAUSDT',
    'DOGEUSDT',
    'AVAXUSDT',
    'DOTUSDT',
    'LINKUSDT',
    'MATICUSDT',
    'LTCUSDT',
    'ATOMUSDT',
    'UNIUSDT',
    'APTUSDT',
    'OPUSDT',
    'ARBUSDT',
    'SUIUSDT',
    'PEPEUSDT',
    'WIFUSDT',
  ];

  private readonly availableStrategies = [
    // New strategies (v2)
    { id: 'CORE_TREND', name: 'Core Trend', description: '4H/1D EMA 기반 멀티타임프레임 추세 추종 전략' },
    { id: 'SQUEEZE', name: 'Squeeze', description: '1H BB 압축 → 15m 돌파 전략' },
    // Legacy strategies (deprecated)
    { id: 'CYCLE_RIDER', name: 'Cycle Rider (Legacy)', description: '15분봉 기반 추세 추종 전략' },
    { id: 'HOUR_SWING', name: 'Hour Swing (Legacy)', description: '1시간봉 기반 스윙 전략' },
    { id: 'BOX_RANGE', name: 'Box Range (Legacy)', description: '박스권 돌파 전략' },
  ];

  constructor(
    @InjectRepository(BacktestRun)
    private readonly backtestRunRepo: Repository<BacktestRun>,
    @InjectRepository(BacktestTrade)
    private readonly backtestTradeRepo: Repository<BacktestTrade>,
    private readonly engine: BacktestEngineService,
    private readonly logger: CustomLoggerService,
  ) {}

  async createAndRun(dto: CreateBacktestDto): Promise<BacktestRun> {
    // Create backtest run
    const run = this.backtestRunRepo.create({
      name: dto.name,
      symbols: dto.symbols,
      strategies: dto.strategies,
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
      initialBalance: dto.initialBalance,
      status: BacktestStatus.PENDING,
    });

    const savedRun = await this.backtestRunRepo.save(run);

    // Start backtest in background
    this.engine.runBacktest(savedRun.id).catch((error) => {
      this.logger.error(`Backtest ${savedRun.id} failed: ${error.message}`, error.stack);
    });

    return savedRun;
  }

  async findAll(limit: number = 20, offset: number = 0): Promise<{
    runs: BacktestRun[];
    total: number;
  }> {
    const [runs, total] = await this.backtestRunRepo.findAndCount({
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { runs, total };
  }

  async findOne(id: string): Promise<BacktestRun | null> {
    return await this.backtestRunRepo.findOne({
      where: { id },
    });
  }

  async getTrades(
    backtestId: string,
    limit: number = 100,
    offset: number = 0,
  ): Promise<{
    trades: BacktestTrade[];
    total: number;
  }> {
    const [trades, total] = await this.backtestTradeRepo.findAndCount({
      where: { backtest_run_id: backtestId },
      order: { entryTime: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { trades, total };
  }

  async getEquityCurve(backtestId: string): Promise<{
    data: { timestamp: string; balance: number; drawdown: number }[];
  }> {
    const run = await this.findOne(backtestId);
    if (!run) {
      return { data: [] };
    }

    const trades = await this.backtestTradeRepo.find({
      where: { backtest_run_id: backtestId, status: TradeStatus.CLOSED },
      order: { exitTime: 'ASC' },
    });

    const data: { timestamp: string; balance: number; drawdown: number }[] = [];
    let balance = Number(run.initialBalance);
    let peak = balance;

    // Add initial point
    data.push({
      timestamp: run.startDate.toISOString(),
      balance,
      drawdown: 0,
    });

    for (const trade of trades) {
      balance += Number(trade.pnlUsd);
      if (balance > peak) peak = balance;
      const drawdown = ((peak - balance) / peak) * 100;

      data.push({
        timestamp: trade.exitTime.toISOString(),
        balance,
        drawdown,
      });
    }

    return { data };
  }

  async getDailyStats(backtestId: string): Promise<{
    data: {
      date: string;
      trades: number;
      pnl: number;
      winRate: number;
    }[];
  }> {
    const trades = await this.backtestTradeRepo.find({
      where: { backtest_run_id: backtestId, status: TradeStatus.CLOSED },
      order: { exitTime: 'ASC' },
    });

    const dailyMap = new Map<string, { trades: number; pnl: number; wins: number }>();

    for (const trade of trades) {
      const date = trade.exitTime.toISOString().split('T')[0];
      const existing = dailyMap.get(date) || { trades: 0, pnl: 0, wins: 0 };
      existing.trades++;
      existing.pnl += Number(trade.pnlUsd);
      if (Number(trade.pnlUsd) > 0) existing.wins++;
      dailyMap.set(date, existing);
    }

    const data = Array.from(dailyMap.entries()).map(([date, stats]) => ({
      date,
      trades: stats.trades,
      pnl: stats.pnl,
      winRate: stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0,
    }));

    return { data };
  }

  async delete(id: string): Promise<{ success: boolean }> {
    const run = await this.findOne(id);
    if (!run) {
      return { success: false };
    }

    // Delete trades first (cascade should handle this, but be explicit)
    await this.backtestTradeRepo.delete({ backtest_run_id: id });
    await this.backtestRunRepo.delete(id);

    return { success: true };
  }

  getAvailableSymbols(): { symbols: string[] } {
    return { symbols: this.availableSymbols };
  }

  getAvailableStrategies(): { strategies: typeof this.availableStrategies } {
    return { strategies: this.availableStrategies };
  }
}
