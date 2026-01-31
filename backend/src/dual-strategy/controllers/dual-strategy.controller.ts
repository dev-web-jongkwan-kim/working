import { Controller, Post, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { UnifiedOrchestratorService } from '../../unified/orchestrator/unified-orchestrator.service';

@Controller('dual-strategy')
export class DualStrategyController {
  constructor(
    private readonly orchestrator: UnifiedOrchestratorService,
  ) {}

  /**
   * Start the trading system
   * Strategies: Core Trend (4H) + Squeeze (15m)
   */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(): Promise<{ message: string; status: any }> {
    await this.orchestrator.start();
    const status = await this.orchestrator.getStatus();
    return {
      message: 'Trading system started (Core Trend + Squeeze)',
      status,
    };
  }

  /**
   * Stop the trading system
   */
  @Post('stop')
  @HttpCode(HttpStatus.OK)
  async stop(): Promise<{ message: string }> {
    await this.orchestrator.stop();
    return {
      message: 'Trading system stopped',
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
