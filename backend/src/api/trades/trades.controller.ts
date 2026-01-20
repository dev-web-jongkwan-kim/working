import { Controller, Get, Param, Query } from '@nestjs/common';
import { TradesService } from './trades.service';
import { BinanceService } from '../../dual-strategy/services/data/binance.service';

@Controller('api/trades')
export class TradesController {
  constructor(
    private readonly tradesService: TradesService,
    private readonly binanceService: BinanceService,
  ) {}

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

  @Get('stats/daily')
  async getDailyStats() {
    return await this.tradesService.getDailyStats();
  }

  @Get('orders/open')
  async getOpenOrders() {
    const orders = await this.binanceService.getAllOpenOrders();
    return orders.map((order: any) => ({
      orderId: order.orderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      price: parseFloat(order.price),
      stopPrice: parseFloat(order.stopPrice || '0'),
      origQty: parseFloat(order.origQty),
      executedQty: parseFloat(order.executedQty),
      status: order.status,
      timeInForce: order.timeInForce,
      reduceOnly: order.reduceOnly,
      closePosition: order.closePosition,
      time: order.time,
      updateTime: order.updateTime,
    }));
  }

  @Get(':tradeId')
  async getTradeById(@Param('tradeId') tradeId: string) {
    return await this.tradesService.getTradeById(tradeId);
  }
}
