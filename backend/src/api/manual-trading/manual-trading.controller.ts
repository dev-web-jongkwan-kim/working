import { Controller, Get, Post, Query } from '@nestjs/common';
import { ManualTradingService } from './manual-trading.service';

@Controller('api/manual-trading')
export class ManualTradingController {
  constructor(private readonly manualTradingService: ManualTradingService) {}

  @Get('account')
  async getAccountSummary() {
    return await this.manualTradingService.getAccountSummary();
  }

  @Post('sync')
  async syncTrades(@Query('days') days?: string) {
    const daysToSync = days ? parseInt(days) : 30;
    return await this.manualTradingService.syncTradesFromBinance(daysToSync);
  }

  @Get('trades')
  async getTrades(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ) {
    return await this.manualTradingService.getTrades(
      startTime ? parseInt(startTime) : undefined,
      endTime ? parseInt(endTime) : undefined,
    );
  }

  @Get('daily-summary')
  async getDailySummary(@Query('days') days?: string) {
    const daysToFetch = days ? parseInt(days) : 30;
    return await this.manualTradingService.getDailySummary(daysToFetch);
  }

  @Get('equity-curve')
  async getEquityCurve(@Query('days') days?: string) {
    const daysToFetch = days ? parseInt(days) : 30;
    return await this.manualTradingService.getEquityCurve(daysToFetch);
  }

  @Get('calendar')
  async getCalendarData(
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    const y = year ? parseInt(year) : new Date().getFullYear();
    const m = month ? parseInt(month) : new Date().getMonth() + 1;
    return await this.manualTradingService.getCalendarData(y, m);
  }
}
