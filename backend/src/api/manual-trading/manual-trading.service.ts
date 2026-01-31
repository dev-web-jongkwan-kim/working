import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual } from 'typeorm';
import { BinanceService } from '../../dual-strategy/services/data/binance.service';
import { ManualTrade } from '../../entities/manual-trade.entity';
import { CustomLoggerService } from '../../common/logging/custom-logger.service';

@Injectable()
export class ManualTradingService {
  constructor(
    private readonly binanceService: BinanceService,
    @InjectRepository(ManualTrade)
    private readonly manualTradeRepo: Repository<ManualTrade>,
    private readonly logger: CustomLoggerService,
  ) {}

  async getAccountSummary() {
    const accountInfo = await this.binanceService.getAccountInfo();

    if (!accountInfo) {
      return {
        balance: 0,
        availableBalance: 0,
        unrealizedPnl: 0,
        marginBalance: 0,
      };
    }

    const usdtAsset = accountInfo.assets?.find(
      (a: any) => a.asset === 'USDT',
    );

    return {
      balance: parseFloat(usdtAsset?.walletBalance || '0'),
      availableBalance: parseFloat(usdtAsset?.availableBalance || '0'),
      unrealizedPnl: parseFloat(usdtAsset?.unrealizedProfit || '0'),
      marginBalance: parseFloat(usdtAsset?.marginBalance || '0'),
      totalWalletBalance: parseFloat(accountInfo.totalWalletBalance || '0'),
      totalUnrealizedProfit: parseFloat(accountInfo.totalUnrealizedProfit || '0'),
    };
  }

  async syncTradesFromBinance(days: number = 30, fullSync: boolean = true) {
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      // fullSync일 경우 기존 데이터 삭제 후 Binance에서 새로 가져옴
      if (fullSync) {
        await this.manualTradeRepo.clear();
        this.logger.log('Cleared existing trades for full sync', 'ManualTradingService');
      }

      // Binance income history로 실현 손익 가져오기
      const incomeHistory = await this.fetchIncomeHistory(startTime);

      let synced = 0;
      let skipped = 0;

      for (const income of incomeHistory) {
        // REALIZED_PNL 타입만 처리
        if (income.incomeType !== 'REALIZED_PNL') continue;

        const existingTrade = await this.manualTradeRepo.findOne({
          where: { tranId: income.tranId.toString() },
        });

        if (existingTrade) {
          skipped++;
          continue;
        }

        const trade = this.manualTradeRepo.create({
          tranId: income.tranId.toString(),
          symbol: income.symbol,
          incomeType: income.incomeType,
          income: parseFloat(income.income),
          asset: income.asset,
          time: new Date(income.time),
          info: income.info || '',
        });

        await this.manualTradeRepo.save(trade);
        synced++;
      }

      this.logger.log(
        `Synced ${synced} trades, skipped ${skipped} existing`,
        'ManualTradingService',
      );

      return {
        success: true,
        synced,
        skipped,
        total: incomeHistory.filter((i: any) => i.incomeType === 'REALIZED_PNL').length,
      };
    } catch (error) {
      this.logger.error(`Failed to sync trades: ${error.message}`, error.stack);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private async fetchIncomeHistory(startTime: number): Promise<any[]> {
    const testnet = process.env.BINANCE_TESTNET === 'true';
    const baseUrl = testnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    const crypto = await import('crypto');
    const allData: any[] = [];
    let currentStartTime = startTime;
    const endTime = Date.now();

    // 페이징으로 모든 데이터 가져오기 (Binance는 한 번에 최대 1000건)
    while (currentStartTime < endTime) {
      const timestamp = Date.now();
      const queryString = `startTime=${currentStartTime}&endTime=${endTime}&limit=1000&timestamp=${timestamp}&recvWindow=5000`;

      const signature = crypto
        .createHmac('sha256', process.env.BINANCE_SECRET_KEY || '')
        .update(queryString)
        .digest('hex');

      const response = await fetch(
        `${baseUrl}/fapi/v1/income?${queryString}&signature=${signature}`,
        {
          headers: {
            'X-MBX-APIKEY': process.env.BINANCE_API_KEY || '',
          },
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      if (!data || data.length === 0) break;

      allData.push(...data);

      // 마지막 데이터의 시간 + 1ms를 다음 시작 시간으로
      const lastTime = data[data.length - 1].time;
      if (lastTime <= currentStartTime) break; // 무한 루프 방지
      currentStartTime = lastTime + 1;

      // 1000건 미만이면 더 이상 데이터 없음
      if (data.length < 1000) break;

      // Rate limit 방지
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger.log(
      `Fetched ${allData.length} income records from Binance`,
      'ManualTradingService',
    );

    return allData;
  }

  async getTrades(startTime?: number, endTime?: number) {
    const where: any = {};

    if (startTime && endTime) {
      where.time = Between(new Date(startTime), new Date(endTime));
    } else if (startTime) {
      where.time = MoreThanOrEqual(new Date(startTime));
    }

    return await this.manualTradeRepo.find({
      where,
      order: { time: 'DESC' },
    });
  }

  async getDailySummary(days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const trades = await this.manualTradeRepo.find({
      where: {
        time: MoreThanOrEqual(startDate),
      },
      order: { time: 'ASC' },
    });

    // 일별 그룹핑
    const dailyMap = new Map<
      string,
      { trades: number; wins: number; pnl: number; date: string }
    >();

    for (const trade of trades) {
      const dateKey = trade.time.toISOString().split('T')[0];
      const income = Number(trade.income);

      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { trades: 0, wins: 0, pnl: 0, date: dateKey });
      }

      const day = dailyMap.get(dateKey)!;
      day.trades++;
      day.pnl += income;
      if (income > 0) day.wins++;
    }

    // 결과 정리
    const result = Array.from(dailyMap.values()).map((day) => ({
      date: day.date,
      totalTrades: day.trades,
      winningTrades: day.wins,
      losingTrades: day.trades - day.wins,
      winRate: day.trades > 0 ? (day.wins / day.trades) * 100 : 0,
      pnl: day.pnl,
    }));

    // 전체 통계
    const totalTrades = trades.length;
    const totalWins = trades.filter((t) => Number(t.income) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + Number(t.income), 0);

    return {
      days: result,
      summary: {
        totalTrades,
        winningTrades: totalWins,
        losingTrades: totalTrades - totalWins,
        winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
        totalPnl,
      },
    };
  }

  async getEquityCurve(days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const trades = await this.manualTradeRepo.find({
      where: {
        time: MoreThanOrEqual(startDate),
      },
      order: { time: 'ASC' },
    });

    // 현재 잔액 가져오기
    const account = await this.getAccountSummary();
    const currentBalance = account.balance;

    // 거래 역순으로 누적 계산하여 시작 잔액 추정
    const totalPnl = trades.reduce((sum, t) => sum + Number(t.income), 0);
    const startingBalance = currentBalance - totalPnl;

    // 거래별 자산 변동 계산
    let runningBalance = startingBalance;
    const equityCurve = trades.map((trade) => {
      const income = Number(trade.income);
      runningBalance += income;
      return {
        time: trade.time,
        symbol: trade.symbol,
        pnl: income,
        balance: runningBalance,
      };
    });

    return {
      startingBalance,
      currentBalance,
      totalPnl,
      curve: equityCurve,
    };
  }

  async getCalendarData(year: number, month: number) {
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const trades = await this.manualTradeRepo.find({
      where: {
        time: Between(startDate, endDate),
      },
      order: { time: 'ASC' },
    });

    // 일별 그룹핑
    const calendarMap = new Map<
      number,
      { trades: number; wins: number; pnl: number }
    >();

    for (const trade of trades) {
      const day = trade.time.getDate();
      const income = Number(trade.income);

      if (!calendarMap.has(day)) {
        calendarMap.set(day, { trades: 0, wins: 0, pnl: 0 });
      }

      const dayData = calendarMap.get(day)!;
      dayData.trades++;
      dayData.pnl += income;
      if (income > 0) dayData.wins++;
    }

    // 결과 배열로 변환
    const daysInMonth = new Date(year, month, 0).getDate();
    const calendar = [];

    for (let day = 1; day <= daysInMonth; day++) {
      const data = calendarMap.get(day);
      if (data) {
        calendar.push({
          day,
          totalTrades: data.trades,
          winningTrades: data.wins,
          losingTrades: data.trades - data.wins,
          winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
          pnl: data.pnl,
          isProfit: data.pnl > 0,
          isLoss: data.pnl < 0,
        });
      } else {
        calendar.push({
          day,
          totalTrades: 0,
          winningTrades: 0,
          losingTrades: 0,
          winRate: 0,
          pnl: 0,
          isProfit: false,
          isLoss: false,
        });
      }
    }

    // 월별 요약
    const monthlyPnl = trades.reduce((sum, t) => sum + Number(t.income), 0);
    const monthlyTrades = trades.length;
    const monthlyWins = trades.filter((t) => Number(t.income) > 0).length;

    return {
      year,
      month,
      calendar,
      summary: {
        totalTrades: monthlyTrades,
        winningTrades: monthlyWins,
        losingTrades: monthlyTrades - monthlyWins,
        winRate: monthlyTrades > 0 ? (monthlyWins / monthlyTrades) * 100 : 0,
        totalPnl: monthlyPnl,
        profitDays: calendar.filter((d) => d.isProfit).length,
        lossDays: calendar.filter((d) => d.isLoss).length,
      },
    };
  }
}
