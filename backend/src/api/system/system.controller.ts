import { Controller, Get, Post, HttpCode, HttpStatus } from '@nestjs/common';
import { DualStrategyOrchestratorService } from '../../dual-strategy/services/orchestrator/dual-strategy-orchestrator.service';
import { LotteryExecutorService } from '../../lottery/lottery-executor.service';

/**
 * System Control API
 * Provides endpoints to start/stop trading system
 */
@Controller('api/system')
export class SystemController {
  constructor(
    private readonly orchestrator: DualStrategyOrchestratorService,
    private readonly lotteryExecutor: LotteryExecutorService,
  ) {}

  /**
   * Start the trading system
   * POST /api/system/start
   * 1. Lottery strategy first (flash crash hunting)
   * 2. Then DualStrategy (Cycle Rider, Hour Swing, Box Range)
   */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  async startSystem(): Promise<{ success: boolean; message: string }> {
    try {
      // 1. Start Lottery Strategy first
      await this.lotteryExecutor.start();

      // 2. Then start DualStrategy
      await this.orchestrator.start();

      return {
        success: true,
        message: 'All trading systems started (Lottery + DualStrategy)',
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to start system: ${error.message}`,
      };
    }
  }

  /**
   * Stop the trading system
   * POST /api/system/stop
   */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stopSystem(): Promise<{ success: boolean; message: string }> {
    try {
      await this.lotteryExecutor.stop();
      await this.orchestrator.stop();
      return {
        success: true,
        message: 'All trading systems stopped (Lottery + DualStrategy)',
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to stop system: ${error.message}`,
      };
    }
  }

  /**
   * Get system status
   * GET /api/system/status
   */
  @Get('status')
  async getSystemStatus() {
    const status = await this.orchestrator.getStatus();
    return {
      success: true,
      data: status,
    };
  }
}
