import { Controller, Get, Param, Query } from '@nestjs/common';
import { TradesService } from './trades.service';

@Controller('api/trades')
export class TradesController {
  constructor(private readonly tradesService: TradesService) {}

  @Get()
  async getAllTrades(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return await this.tradesService.getAllTrades(
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 50,
    );
  }

  @Get('active')
  async getActiveTrades() {
    return await this.tradesService.getActiveTrades();
  }

  @Get('closed')
  async getClosedTrades(@Query('limit') limit?: string) {
    return await this.tradesService.getClosedTrades(
      limit ? parseInt(limit) : 50,
    );
  }

  @Get('today')
  async getTodayTrades() {
    return await this.tradesService.getTodayTrades();
  }

  @Get('strategy/:strategyType')
  async getTradesByStrategy(@Param('strategyType') strategyType: string) {
    return await this.tradesService.getTradesByStrategy(strategyType);
  }

  @Get('symbol/:symbol')
  async getTradesBySymbol(@Param('symbol') symbol: string) {
    return await this.tradesService.getTradesBySymbol(symbol);
  }

  @Get('performance')
  async getPerformance() {
    return await this.tradesService.getPerformanceSummary();
  }

  @Get(':tradeId')
  async getTradeById(@Param('tradeId') tradeId: string) {
    return await this.tradesService.getTradeById(tradeId);
  }
}
