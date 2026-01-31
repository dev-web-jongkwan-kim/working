import { Controller, Get, Post, Body, Param, Delete, Query } from '@nestjs/common';
import { BacktestService } from './backtest.service';

interface CreateBacktestDto {
  name: string;
  symbols: string[];
  strategies: string[];
  startDate: string;
  endDate: string;
  initialBalance: number;
}

@Controller('api/backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post()
  async createBacktest(@Body() dto: CreateBacktestDto) {
    return await this.backtestService.createAndRun(dto);
  }

  @Get()
  async getAllBacktests(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return await this.backtestService.findAll(
      limit ? parseInt(limit) : 20,
      offset ? parseInt(offset) : 0,
    );
  }

  @Get('available-symbols')
  async getAvailableSymbols() {
    return this.backtestService.getAvailableSymbols();
  }

  @Get('available-strategies')
  async getAvailableStrategies() {
    return this.backtestService.getAvailableStrategies();
  }

  @Get(':id')
  async getBacktest(@Param('id') id: string) {
    return await this.backtestService.findOne(id);
  }

  @Get(':id/trades')
  async getBacktestTrades(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return await this.backtestService.getTrades(
      id,
      limit ? parseInt(limit) : 100,
      offset ? parseInt(offset) : 0,
    );
  }

  @Get(':id/equity-curve')
  async getEquityCurve(@Param('id') id: string) {
    return await this.backtestService.getEquityCurve(id);
  }

  @Get(':id/daily-stats')
  async getDailyStats(@Param('id') id: string) {
    return await this.backtestService.getDailyStats(id);
  }

  @Delete(':id')
  async deleteBacktest(@Param('id') id: string) {
    return await this.backtestService.delete(id);
  }
}
