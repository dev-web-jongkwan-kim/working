/**
 * Legacy Dual Strategy Orchestrator (DEPRECATED)
 *
 * This orchestrator has been replaced by UnifiedOrchestratorService.
 * It is kept only for API backwards compatibility.
 *
 * Legacy strategies (CYCLE_RIDER, HOUR_SWING, BOX_RANGE) have been removed.
 * Use UnifiedOrchestratorService with CoreTrendStrategy and SqueezeStrategy instead.
 */

import { Injectable, OnModuleInit } from '@nestjs/common';
import { MarketRegimeClassifierService } from '../regime/market-regime-classifier.service';
import { PositionManagerService } from '../execution/position-manager.service';
import { DataCollectorService } from '../data/data-collector.service';
import { SymbolFetcherService } from '../data/symbol-fetcher.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { SystemEventType } from '../../../entities/system-log.entity';

/**
 * @deprecated Use UnifiedOrchestratorService instead
 */
@Injectable()
export class DualStrategyOrchestratorService implements OnModuleInit {
  private isRunning = false;
  private symbols: string[] = [];

  constructor(
    private readonly regimeClassifier: MarketRegimeClassifierService,
    private readonly positionManager: PositionManagerService,
    private readonly dataCollector: DataCollectorService,
    private readonly symbolFetcher: SymbolFetcherService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onModuleInit() {
    this.symbols = await this.symbolFetcher.getTopSymbols(100);
    this.logger.warn(
      '⚠️  DualStrategyOrchestratorService is DEPRECATED. Use UnifiedOrchestratorService for CoreTrend + Squeeze strategies.',
      'DualStrategyOrchestrator',
    );
  }

  /**
   * @deprecated Use UnifiedOrchestratorService.start() instead
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('System already running', 'DualStrategyOrchestrator');
      return;
    }

    this.logger.warn(
      '⚠️  DEPRECATED: Legacy strategies removed. Please use UnifiedOrchestratorService.',
      'DualStrategyOrchestrator',
    );

    this.isRunning = true;

    await this.logger.logSystem({
      level: 'warn',
      eventType: SystemEventType.SYSTEM_START,
      message: 'DEPRECATED: DualStrategyOrchestrator started (legacy strategies removed)',
      component: 'DualStrategyOrchestrator',
    });

    // Start data collection (still useful for UnifiedOrchestrator)
    await this.dataCollector.startCollection(this.symbols);

    // Initial regime classification
    await this.regimeClassifier.classifyRegime();

    this.logger.log(
      '✅ Data collection started. Use UnifiedOrchestratorService for trading.',
      'DualStrategyOrchestrator',
    );
  }

  /**
   * @deprecated Use UnifiedOrchestratorService.stop() instead
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.log('⏹️  Stopping data collection...', 'DualStrategyOrchestrator');

    await this.logger.logSystem({
      level: 'info',
      eventType: SystemEventType.SYSTEM_STOP,
      message: 'DualStrategyOrchestrator stopped',
      component: 'DualStrategyOrchestrator',
    });

    await this.dataCollector.stopCollection();
    this.logger.log('System stopped', 'DualStrategyOrchestrator');
  }

  /**
   * Get system status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    symbols: string[];
    activePositions: number;
    currentRegime: any;
    deprecationWarning: string;
  }> {
    const positions = await this.positionManager.getActivePositions();
    const regime = this.regimeClassifier.getCurrentRegime();

    return {
      isRunning: this.isRunning,
      symbols: this.symbols,
      activePositions: positions.length,
      currentRegime: { regime },
      deprecationWarning: 'This orchestrator is deprecated. Use UnifiedOrchestratorService.',
    };
  }

  /**
   * @deprecated No longer functional - use UnifiedOrchestratorService.runManualScan()
   */
  async runManualScan(): Promise<{
    scannedSymbols: number;
    queueSize: number;
    errors: string[];
    deprecationWarning: string;
  }> {
    return {
      scannedSymbols: 0,
      queueSize: 0,
      errors: [],
      deprecationWarning: 'Legacy strategies removed. Use UnifiedOrchestratorService.',
    };
  }
}
