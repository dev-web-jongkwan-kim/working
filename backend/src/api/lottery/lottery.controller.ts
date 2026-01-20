import { Controller, Get, Post, Query } from '@nestjs/common';
import { LotteryService } from './lottery.service';
import { LotteryExecutorService } from '../../lottery/lottery-executor.service';

@Controller('api/lottery')
export class LotteryController {
  constructor(
    private readonly lotteryService: LotteryService,
    private readonly lotteryExecutor: LotteryExecutorService,
  ) {}

  /**
   * Get active lottery orders (PENDING + FILLED)
   */
  @Get('active')
  async getActiveOrders() {
    return this.lotteryService.getActiveOrders();
  }

  /**
   * Get closed lottery orders
   */
  @Get('closed')
  async getClosedOrders(@Query('limit') limit = '50') {
    return this.lotteryService.getClosedOrders(parseInt(limit, 10));
  }

  /**
   * Get lottery performance summary
   */
  @Get('performance')
  async getPerformance() {
    return this.lotteryService.getPerformanceSummary();
  }

  /**
   * Get latest selection history
   */
  @Get('history')
  async getSelectionHistory(@Query('limit') limit = '20') {
    return this.lotteryService.getSelectionHistory(parseInt(limit, 10));
  }

  /**
   * Manually execute lottery (for testing)
   */
  @Post('execute')
  async executeNow() {
    await this.lotteryExecutor.execute();
    return { message: 'Lottery execution triggered' };
  }
}
