import { Controller, Post, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { DualStrategyOrchestratorService } from '../services/orchestrator/dual-strategy-orchestrator.service';
import { LotteryExecutorService } from '../../lottery/lottery-executor.service';

@Controller('dual-strategy')
export class DualStrategyController {
  constructor(
    private readonly orchestrator: DualStrategyOrchestratorService,
    private readonly lotteryExecutor: LotteryExecutorService,
  ) {}

  /**
   * Start the trading system
   * 1. Lottery strategy first (flash crash hunting)
   * 2. Then DualStrategy (Cycle Rider, Hour Swing, Box Range)
   */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(): Promise<{ message: string; status: any }> {
    // 1. Start Lottery Strategy first
    await this.lotteryExecutor.start();

    // 2. Then start DualStrategy
    await this.orchestrator.start();

    const status = await this.orchestrator.getStatus();
    return {
      message: 'All trading systems started (Lottery + DualStrategy)',
      status,
    };
  }

  /**
   * Stop the trading system
   */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(): Promise<{ message: string }> {
    await this.lotteryExecutor.stop();
    await this.orchestrator.stop();
    return {
      message: 'All trading systems stopped (Lottery + DualStrategy)',
    };
  }

  /**
   * Get system status
   */
  @Get('status')
  async getStatus(): Promise<any> {
    return await this.orchestrator.getStatus();
  }

  /**
   * Manual scan trigger - run all strategies for all symbols immediately
   * Useful when system was down and missed scheduled scans
   */
  @Post('scan-now')
  @HttpCode(HttpStatus.OK)
  async scanNow(): Promise<{ success: boolean; message: string; results: any }> {
    const results = await this.orchestrator.runManualScan();
    return {
      success: true,
      message: 'Manual scan completed',
      results,
    };
  }
}
