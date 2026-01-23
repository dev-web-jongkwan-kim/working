import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { MarketRegimeClassifierService } from '../regime/market-regime-classifier.service';
import { CycleRiderSignalService } from '../cycle-rider/cycle-rider-signal.service';
import { HourSwingSignalService } from '../hour-swing/hour-swing-signal.service';
import { BoxRangeSignalService } from '../box-range/box-range-signal.service';
import { OrderExecutorService } from '../execution/order-executor.service';
import { PositionManagerService } from '../execution/position-manager.service';
import { RiskManagerService } from '../execution/risk-manager.service';
import { SignalQueueService } from '../execution/signal-queue.service';
import { DataCollectorService } from '../data/data-collector.service';
import { DataCacheService } from '../data/data-cache.service';
import { SymbolFetcherService } from '../data/symbol-fetcher.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { SystemEventType } from '../../../entities/system-log.entity';
import { CYCLE_RIDER_CONFIG } from '../../constants/cycle-rider.config';
import { HOUR_SWING_CONFIG } from '../../constants/hour-swing.config';
import { BOX_RANGE_CONFIG } from '../../constants/box-range.config';
import { CandleClosedEvent } from '../../events/candle-closed.event';

/**
 * Tri-Strategy Orchestrator
 * Main coordinator that runs all 3 strategies: Cycle Rider, Hour Swing, and Box Range
 */
@Injectable()
export class DualStrategyOrchestratorService implements OnModuleInit {
  private isRunning = false;
  private symbols: string[] = [];
  private processingSymbols: Set<string> = new Set(); // Prevent duplicate signals

  // Hour Swing concurrent entry tracking (5분 내 동시 진입 제한)
  private hourSwingEntryTimestamps: number[] = [];

  // 1m Entry Performance Tracking
  private oneMinuteStats = {
    boxRangeChecks: 0,
    boxRangeEntries: 0,
    fundingExtremesChecks: 0,
    fundingExtremesEntries: 0,
    lastResetTime: Date.now(),
  };
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly regimeClassifier: MarketRegimeClassifierService,
    private readonly cycleRiderSignal: CycleRiderSignalService,
    private readonly hourSwingSignal: HourSwingSignalService,
    private readonly boxRangeSignal: BoxRangeSignalService,
    private readonly orderExecutor: OrderExecutorService,
    private readonly positionManager: PositionManagerService,
    private readonly riskManager: RiskManagerService,
    private readonly signalQueue: SignalQueueService,
    private readonly dataCollector: DataCollectorService,
    private readonly cacheService: DataCacheService,
    private readonly symbolFetcher: SymbolFetcherService,
    private readonly logger: CustomLoggerService,
  ) {}

  async onModuleInit() {
    // Fetch top 100 symbols by volume
    this.symbols = await this.symbolFetcher.getTopSymbols(100);
    this.logger.log(
      `🎯 Tri-Strategy System ready with ${this.symbols.length} symbols (Cycle Rider + Hour Swing + Box Range). Use API to start trading.`,
      'DualStrategyOrchestrator',
    );
  }

  /**
   * Start the trading system
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('System already running', 'DualStrategyOrchestrator');
      return;
    }

    this.isRunning = true;
    this.logger.log('🚀 Tri-Strategy Trading System starting...', 'DualStrategyOrchestrator');

    await this.logger.logSystem({
      level: 'info',
      eventType: SystemEventType.SYSTEM_START,
      message: 'Tri-Strategy System started (Cycle Rider + Hour Swing + Box Range)',
      component: 'DualStrategyOrchestrator',
      metadata: {
        symbols: this.symbols,
        strategies: ['CYCLE_RIDER', 'HOUR_SWING', 'BOX_RANGE'],
      },
    });

    // Clear signal queue on startup (prevent stale signals from previous run)
    await this.signalQueue.clearQueue();
    this.logger.log('🧹 Signal queue cleared on startup', 'DualStrategyOrchestrator');

    // Start data collection
    await this.dataCollector.startCollection(this.symbols);

    // Initialize funding rate history for Funding Extremes strategy
    this.logger.log('⏳ Initializing funding rate history...', 'DualStrategyOrchestrator');
    await this.hourSwingSignal.initializeFundingHistory(this.symbols);

    // Initial regime classification
    await this.regimeClassifier.classifyRegime();

    // Start periodic cleanup for 1m entry caches (every 30 minutes)
    this.cleanupInterval = setInterval(() => {
      this.cleanupCaches();
    }, 30 * 60 * 1000);

    this.logger.log(
      '✅ System started successfully (1분봉 실시간 진입 시스템 활성화)',
      'DualStrategyOrchestrator',
    );
    this.logger.log(
      '[1M-Entry] 📊 실시간 진입 체크 활성화: Box Range 활성박스 + Funding Extremes 리버설존',
      'DualStrategyOrchestrator',
    );
  }

  /**
   * Stop the trading system
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.log('⏹️  Stopping Tri-Strategy Trading System...', 'DualStrategyOrchestrator');

    await this.logger.logSystem({
      level: 'info',
      eventType: SystemEventType.SYSTEM_STOP,
      message: 'Tri-Strategy System stopped',
      component: 'DualStrategyOrchestrator',
    });

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Stop data collection
    await this.dataCollector.stopCollection();

    // Log final 1m entry stats
    this.log1mEntryStats();

    this.logger.log('System stopped', 'DualStrategyOrchestrator');
  }

  /**
   * Periodic cleanup of stale caches
   */
  private cleanupCaches(): void {
    this.logger.debug('[1M-Entry] Running periodic cache cleanup...', 'DualStrategyOrchestrator');

    // Cleanup Box Range caches
    this.boxRangeSignal.cleanupCaches();

    // Cleanup Funding Extremes history
    // Note: Funding Extremes has auto-cleanup in hasActiveExtreme() check

    // Log stats every cleanup cycle (30 min)
    this.log1mEntryStats();
  }

  /**
   * Log 1m entry statistics
   */
  private log1mEntryStats(): void {
    const uptime = Date.now() - this.oneMinuteStats.lastResetTime;
    const uptimeMinutes = Math.floor(uptime / 60000);

    this.logger.log(
      `[1M-Entry] 📊 Statistics (${uptimeMinutes}분): ` +
        `Box Range 체크=${this.oneMinuteStats.boxRangeChecks}, 진입=${this.oneMinuteStats.boxRangeEntries} | ` +
        `Funding Extremes 체크=${this.oneMinuteStats.fundingExtremesChecks}, 진입=${this.oneMinuteStats.fundingExtremesEntries}`,
      'DualStrategyOrchestrator',
    );

    // Reset stats
    this.oneMinuteStats = {
      boxRangeChecks: 0,
      boxRangeEntries: 0,
      fundingExtremesChecks: 0,
      fundingExtremesEntries: 0,
      lastResetTime: Date.now(),
    };
  }

  /**
   * Manual scan trigger - runs all strategies for all symbols immediately
   * Useful when system was down and missed scheduled scans
   */
  async runManualScan(): Promise<{
    scannedSymbols: number;
    queueSize: number;
    errors: string[];
  }> {
    if (!this.isRunning) {
      throw new Error('System is not running. Start the system first.');
    }

    this.logger.log('🔄 [Manual Scan] Starting manual scan for all symbols...', 'DualStrategyOrchestrator');

    const results = {
      scannedSymbols: 0,
      queueSize: 0,
      errors: [] as string[],
    };

    const regime = this.regimeClassifier.getCurrentRegime();
    const weights = this.regimeClassifier.getStrategyWeights();
    const positions = await this.positionManager.getActivePositions();

    // Scan each symbol
    for (const symbol of this.symbols) {
      if (this.processingSymbols.has(symbol)) {
        continue;
      }

      try {
        results.scannedSymbols++;

        // Run Cycle Rider
        const cycleRiderCount = positions.filter((p) => p.strategy_type === 'CYCLE_RIDER').length;
        if (cycleRiderCount < CYCLE_RIDER_CONFIG.position.maxPositions) {
          await this.runCycleRiderForSymbol(symbol, regime, positions, weights.cycleRider);
          // Note: Cycle Rider processes directly, doesn't return signal
        }

        // Run Box Range
        const boxRangeCount = positions.filter((p) => p.strategy_type === 'BOX_RANGE').length;
        if (boxRangeCount < BOX_RANGE_CONFIG.position.maxPositions) {
          await this.runBoxRangeForSymbol(symbol, regime, positions);
          // Note: Box Range doesn't return signal directly, it stores boxes for 1m entry
        }

        // Run Hour Swing
        const hourSwingCount = positions.filter((p) => p.strategy_type === 'HOUR_SWING').length;
        if (hourSwingCount < HOUR_SWING_CONFIG.position.maxPositions) {
          await this.runHourSwingForSymbol(symbol, regime, positions, weights.hourSwing);
          // Note: Hour Swing adds to queue, doesn't return signal directly
        }
      } catch (error) {
        results.errors.push(`${symbol}: ${error.message}`);
      }
    }

    // Get final queue size
    results.queueSize = await this.signalQueue.getQueueSize();

    this.logger.log(
      `✅ [Manual Scan] Completed: ${results.scannedSymbols} symbols scanned, ` +
        `${results.queueSize} signals in queue, ${results.errors.length} errors`,
      'DualStrategyOrchestrator',
    );

    return results;
  }

  /**
   * Check if a symbol has recent trading activity
   * Returns true if symbol has non-zero volume in last 45 minutes
   */
  private async checkRecentActivity(symbol: string): Promise<boolean> {
    try {
      // Fetch last 3 candles (45 minutes on 15m timeframe)
      const baseUrl = 'https://fapi.binance.com';
      const response = await fetch(
        `${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=3`
      );

      if (!response.ok) {
        this.logger.warn(
          `Failed to check activity for ${symbol}: HTTP ${response.status}`,
          'DualStrategyOrchestrator',
        );
        return false;
      }

      const klines = await response.json();

      // Check if all 3 candles have volume > 0
      const hasVolume = klines.every((kline: any[]) => parseFloat(kline[5]) > 0);

      if (hasVolume) {
        this.logger.debug(
          `✅ ${symbol} is active (volume confirmed)`,
          'DualStrategyOrchestrator',
        );
      } else {
        this.logger.debug(
          `❌ ${symbol} is inactive (zero volume detected)`,
          'DualStrategyOrchestrator',
        );
      }

      return hasVolume;
    } catch (error) {
      this.logger.warn(
        `Error checking activity for ${symbol}: ${error.message}`,
        'DualStrategyOrchestrator',
      );
      return false;
    }
  }

  /**
   * Handle inactive symbol replacement
   * When a symbol has consecutive zero-volume candles, replace it with a new active symbol
   */
  @OnEvent('symbol.inactive')
  async handleInactiveSymbol(event: { symbol: string }): Promise<void> {
    const inactiveSymbol = event.symbol;

    this.logger.warn(
      `🔄 Replacing inactive symbol ${inactiveSymbol} with new active symbol...`,
      'DualStrategyOrchestrator',
    );

    // Remove from our symbols list
    const index = this.symbols.indexOf(inactiveSymbol);
    if (index !== -1) {
      this.symbols.splice(index, 1);
    }

    // Clear symbolFetcher cache to get fresh data
    this.symbolFetcher.clearCache();

    // Fetch more symbols to find an active replacement
    const allSymbols = await this.symbolFetcher.getTopSymbols(200);

    // Find first 10 candidates not already in our list
    const potentialSymbols = allSymbols
      .filter(s => !this.symbols.includes(s))
      .slice(0, 10);

    this.logger.log(
      `🔍 Checking ${potentialSymbols.length} potential replacement symbols for activity...`,
      'DualStrategyOrchestrator',
    );

    // Check each candidate for recent activity
    let newSymbol: string | null = null;
    for (const candidate of potentialSymbols) {
      const isActive = await this.checkRecentActivity(candidate);
      if (isActive) {
        newSymbol = candidate;
        break;
      }
      // Small delay to avoid hitting rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (newSymbol) {
      this.logger.log(
        `✅ Adding replacement symbol: ${newSymbol} (verified active)`,
        'DualStrategyOrchestrator',
      );

      // Add to our list
      this.symbols.push(newSymbol);

      // Start collection for new symbol
      await this.dataCollector.addSymbol(newSymbol);

      this.logger.log(
        `📊 Symbol count maintained at ${this.symbols.length} (replaced ${inactiveSymbol} → ${newSymbol})`,
        'DualStrategyOrchestrator',
      );
    } else {
      this.logger.warn(
        `⚠️  Could not find active replacement for ${inactiveSymbol}, continuing with ${this.symbols.length} symbols`,
        'DualStrategyOrchestrator',
      );
    }
  }

  /**
   * CRITICAL: Event-driven signal generation (< 0.1s reaction time)
   * Triggered immediately when 15m or 1h candle closes
   * This is the PRIMARY method - Cron is just a backup
   */
  @OnEvent('candle.closed')
  async handleCandleClosed(event: CandleClosedEvent): Promise<void> {
    if (!this.isRunning) return;

    // Only process if this symbol is in our trading list
    if (!this.symbols.includes(event.symbol)) return;

    // Prevent duplicate processing
    if (this.processingSymbols.has(event.symbol)) {
      this.logger.debug(
        `Skipping ${event.symbol} - already processing`,
        'DualStrategyOrchestrator',
      );
      return;
    }

    this.logger.log(
      `⚡ INSTANT REACTION: ${event.symbol} ${event.timeframe} candle closed @ ${event.closePrice}`,
      'DualStrategyOrchestrator',
    );

    try {
      const regime = this.regimeClassifier.getCurrentRegime();
      const weights = this.regimeClassifier.getStrategyWeights();
      const positions = await this.positionManager.getActivePositions();

      // Process based on timeframe
      if (event.timeframe === '15m') {
        // PRIORITY 1: Cycle Rider strategy (highest priority)
        const cycleRiderCount = positions.filter((p) => p.strategy_type === 'CYCLE_RIDER').length;
        if (cycleRiderCount < CYCLE_RIDER_CONFIG.position.maxPositions) {
          const cycleSignalDetected = await this.runCycleRiderForSymbol(event.symbol, regime, positions, weights.cycleRider);

          // If Cycle Rider generated signal, disable Box Range for this symbol
          if (cycleSignalDetected && BOX_RANGE_CONFIG.conflictResolution.cycleRiderPriority) {
            this.boxRangeSignal.disableByCycleRider(event.symbol);
          }
        }

        // PRIORITY 2: Box Range strategy (runs on same 15m timeframe, lower priority)
        const boxRangeCount = positions.filter((p) => p.strategy_type === 'BOX_RANGE').length;
        if (boxRangeCount < BOX_RANGE_CONFIG.position.maxPositions) {
          await this.runBoxRangeForSymbol(event.symbol, regime, positions);
        }

        // PRIORITY 3: Funding Extremes detection (register for 1M-Entry checking)
        // Note: This only detects and registers extremes, actual entry is via 1M candle checks
        await this.hourSwingSignal.detectFundingExtremesOnly(event.symbol);

        // PRIORITY 4: Hour Swing strategy (also runs on 15m for more frequent signal checking)
        const hourSwingCount = positions.filter((p) => p.strategy_type === 'HOUR_SWING').length;
        if (hourSwingCount < HOUR_SWING_CONFIG.position.maxPositions) {
          await this.runHourSwingForSymbol(event.symbol, regime, positions, weights.hourSwing);
        }
      } else if (event.timeframe === '1h') {
        // Hour Swing strategy (also runs on 1h for additional coverage)
        const hourSwingCount = positions.filter((p) => p.strategy_type === 'HOUR_SWING').length;
        if (hourSwingCount < HOUR_SWING_CONFIG.position.maxPositions) {
          await this.runHourSwingForSymbol(event.symbol, regime, positions, weights.hourSwing);
        }
      }
    } catch (error) {
      this.logger.error(
        `Error in event-driven signal processing for ${event.symbol}: ${error.message}`,
        error.stack,
        'DualStrategyOrchestrator',
      );
    }
  }

  /**
   * Handle 1m candle close events for real-time entry checking
   * PHASE 1: Box Range entry-only checking (no re-detection)
   * PHASE 2: Funding Extremes reversal zone checking
   */
  @OnEvent('candle.closed.1m')
  async handle1mCandleClosed(event: CandleClosedEvent): Promise<void> {
    if (!this.isRunning) return;

    // Only process if this symbol is in our trading list
    if (!this.symbols.includes(event.symbol)) return;

    // Skip if already processing this symbol
    if (this.processingSymbols.has(event.symbol)) return;

    const currentPrice = event.closePrice;
    const symbol = event.symbol;

    try {
      // PHASE 1: Box Range entry checking (only for symbols with active boxes)
      if (this.boxRangeSignal.hasActiveBox(symbol)) {
        this.oneMinuteStats.boxRangeChecks++;

        this.logger.log(
          `[1M-Entry] ${symbol} has active box, checking entry @ ${currentPrice.toFixed(4)}`,
          'DualStrategyOrchestrator',
        );

        const positions = await this.positionManager.getActivePositions();
        const boxRangeCount = positions.filter((p) => p.strategy_type === 'BOX_RANGE').length;

        // Check position limit
        if (boxRangeCount >= BOX_RANGE_CONFIG.position.maxPositions) {
          this.logger.debug(
            `[1M-Entry] ${symbol} Box Range at max positions (${boxRangeCount}/${BOX_RANGE_CONFIG.position.maxPositions})`,
            'DualStrategyOrchestrator',
          );
          return;
        }

        // Get funding rate
        const fundingRate = await this.cacheService.getFundingRate(symbol);

        // Check entry conditions
        const signal = await this.boxRangeSignal.checkEntryOnly(symbol, currentPrice, fundingRate);

        if (signal && signal.detected) {
          this.oneMinuteStats.boxRangeEntries++;

          this.logger.log(
            `[1M-Entry] ${symbol} ⚡ BOX RANGE 1분봉 진입 신호! ${signal.direction} @ ${signal.entryPrice.toFixed(4)} ` +
              `(Grade=${signal.metadata.boxGrade}, Quality=${signal.metadata.boxSwingQuality})`,
            'DualStrategyOrchestrator',
          );

          // Execute the signal
          this.processingSymbols.add(symbol);
          try {
            const regime = this.regimeClassifier.getCurrentRegime();
            await this.orderExecutor.executeOrder({
              symbol,
              direction: signal.direction,
              strategyType: signal.strategyType,
              subStrategy: signal.subStrategy,
              entryPrice: signal.entryPrice,
              slPrice: signal.slPrice,
              tp1Price: signal.tp1Price,
              tp2Price: signal.tp2Price,
              leverage: signal.metadata.leverage || BOX_RANGE_CONFIG.position.baseLeverage,
              marginUsd: signal.metadata.marginUsd || BOX_RANGE_CONFIG.position.marginUsd,
              useTrailing: signal.useTrailing,
              confidence: signal.confidence,
              marketRegime: regime,
              metadata: signal.metadata,
            });
          } finally {
            this.processingSymbols.delete(symbol);
          }
        }
      }

      // PHASE 2: Funding Extremes reversal zone checking
      if (this.hourSwingSignal.hasActiveExtreme(symbol)) {
        this.oneMinuteStats.fundingExtremesChecks++;

        this.logger.log(
          `[1M-Entry] ${symbol} has active funding extreme, checking reversal zone @ ${currentPrice.toFixed(4)}`,
          'DualStrategyOrchestrator',
        );

        const positions = await this.positionManager.getActivePositions();
        const hourSwingCount = positions.filter((p) => p.strategy_type === 'HOUR_SWING').length;

        // Check position limit
        if (hourSwingCount >= HOUR_SWING_CONFIG.position.maxPositions) {
          this.logger.debug(
            `[1M-Entry] ${symbol} Hour Swing at max positions (${hourSwingCount}/${HOUR_SWING_CONFIG.position.maxPositions})`,
            'DualStrategyOrchestrator',
          );
          return;
        }

        // Get 1h candles for analysis
        const candles = await this.cacheService.getRecentCandles(symbol, '1h', 24);
        if (!candles || candles.length < 20) {
          this.logger.debug(
            `[1M-Entry] ${symbol} Insufficient candle data for Funding Extremes check`,
            'DualStrategyOrchestrator',
          );
          return;
        }

        // Check reversal zone entry
        const signal = await this.hourSwingSignal.checkFundingExtremesReversalZone(
          symbol,
          candles,
          currentPrice,
        );

        if (signal && signal.detected) {
          this.oneMinuteStats.fundingExtremesEntries++;

          this.logger.log(
            `[1M-Entry] ${symbol} ⚡ FUNDING EXTREMES 1분봉 진입 신호! ${signal.direction} @ ${signal.entryPrice.toFixed(4)} ` +
              `(zScore=${signal.metadata.fundingZScore.toFixed(2)}, RSI=${signal.metadata.rsi.toFixed(1)})`,
            'DualStrategyOrchestrator',
          );

          // Execute the signal
          this.processingSymbols.add(symbol);
          try {
            const regime = this.regimeClassifier.getCurrentRegime();
            await this.orderExecutor.executeOrder({
              symbol,
              direction: signal.direction,
              strategyType: signal.strategyType,
              subStrategy: signal.subStrategy,
              entryPrice: signal.entryPrice,
              slPrice: signal.slPrice,
              tp1Price: signal.tp1Price,
              tp2Price: signal.tp2Price,
              leverage: HOUR_SWING_CONFIG.position.leverage,
              marginUsd: HOUR_SWING_CONFIG.position.marginUsd,
              useTrailing: signal.useTrailing,
              confidence: signal.confidence,
              marketRegime: regime,
              metadata: signal.metadata,
            });
          } finally {
            this.processingSymbols.delete(symbol);
          }
        }
      }

    } catch (error) {
      this.logger.error(
        `[1M-Entry] Error processing 1m candle for ${symbol}: ${error.message}`,
        error.stack,
        'DualStrategyOrchestrator',
      );
      this.processingSymbols.delete(symbol);
    }
  }

  // REMOVED: Cron-based signal generation - now 100% event-driven

  // REMOVED: runCycleRider and runHourSwing (Cron-based bulk processing)
  // Now using event-driven runCycleRiderForSymbol and runHourSwingForSymbol

  /**
   * Process Cycle Rider for a single symbol (event-driven)
   * Returns true if signal was detected and queued/processed
   */
  private async runCycleRiderForSymbol(
    symbol: string,
    regime: any,
    positions: any[],
    weight: number,
  ): Promise<boolean> {
    // Early returns BEFORE adding to processingSymbols
    if (weight < 0.3) return false;
    if (this.processingSymbols.has(symbol)) return false;
    if (positions.some((p) => p.symbol === symbol)) return false;

    if (
      await this.positionManager.isInCooldown(
        symbol,
        'CYCLE_RIDER',
        CYCLE_RIDER_CONFIG.position.cooldownMinutes,
      )
    ) {
      return false;
    }

    const symbolRiskCheck = await this.riskManager.canOpenNewPosition(symbol, undefined);
    if (!symbolRiskCheck.allowed) return false;

    // CRITICAL: Add to processingSymbols ONLY after all preconditions pass
    this.processingSymbols.add(symbol);

    try {
      const signal = await this.cycleRiderSignal.generateSignal(symbol, regime);

      if (!signal?.detected) {
        return false; // No signal detected
      }

      // CRITICAL: Centralized validation (no code duplication)
      const validation = await this.validateLongSignal(signal, symbol, 'Cycle Rider');
      if (!validation.allowed) {
        return false; // Validation failed
      }

      // NEW: Short-term momentum check before entry
      const momentumCheck = await this.checkShortTermMomentum(signal.direction);
      if (!momentumCheck.allowed) {
        this.logger.warn(
          `[Cycle Rider] ${symbol} ❌ MOMENTUM FILTER: ${momentumCheck.reason}`,
          'DualStrategyOrchestrator',
        );
        return false;
      }

      // Add leverage and margin to metadata for queue processing
      signal.metadata = {
        ...signal.metadata,
        leverage: CYCLE_RIDER_CONFIG.position.leverage,
        marginUsd: CYCLE_RIDER_CONFIG.position.marginUsd,
      };

      // Add to signal queue for staggered processing
      const added = await this.signalQueue.addToQueue(signal, symbol, regime);

      if (added) {
        this.logger.log(
          `⚡📊 [Cycle Rider] ${symbol} ${signal.direction} queued - ${signal.subStrategy}`,
          'DualStrategyOrchestrator',
        );
        this.positionManager.setCooldown(symbol, 'CYCLE_RIDER');
        return true;
      } else {
        this.logger.debug(
          `[Cycle Rider] ${symbol} already in queue, skipping duplicate`,
          'DualStrategyOrchestrator',
        );
        return false;
      }
    } finally {
      // CRITICAL: Always remove from processing set
      this.processingSymbols.delete(symbol);
    }
  }

  /**
   * Process Hour Swing for a single symbol (event-driven)
   */
  private async runHourSwingForSymbol(
    symbol: string,
    regime: any,
    positions: any[],
    weight: number,
  ): Promise<void> {
    // Early returns BEFORE adding to processingSymbols
    if (weight < 0.3) return;
    if (this.processingSymbols.has(symbol)) return;
    if (positions.some((p) => p.symbol === symbol)) return;

    if (
      await this.positionManager.isInCooldown(
        symbol,
        'HOUR_SWING',
        HOUR_SWING_CONFIG.position.cooldownMinutes,
      )
    ) {
      return;
    }

    const symbolRiskCheck = await this.riskManager.canOpenNewPosition(symbol, undefined);
    if (!symbolRiskCheck.allowed) return;

    // CRITICAL: Add to processingSymbols ONLY after all preconditions pass
    this.processingSymbols.add(symbol);

    try {
      const signal = await this.hourSwingSignal.generateSignal(symbol, regime);

      if (!signal?.detected) {
        return; // No signal detected
      }

      // CRITICAL: Centralized validation (no code duplication)
      const validation = await this.validateLongSignal(signal, symbol, 'Hour Swing');
      if (!validation.allowed) {
        return; // Validation failed
      }

      // NEW: Short-term momentum check before entry
      const momentumCheck = await this.checkShortTermMomentum(signal.direction);
      if (!momentumCheck.allowed) {
        this.logger.warn(
          `[Hour Swing] ${symbol} ❌ MOMENTUM FILTER: ${momentumCheck.reason}`,
          'DualStrategyOrchestrator',
        );
        return;
      }

      // Add leverage and margin to metadata for queue processing
      signal.metadata = {
        ...signal.metadata,
        leverage: HOUR_SWING_CONFIG.position.leverage,
        marginUsd: HOUR_SWING_CONFIG.position.marginUsd,
      };

      // Add to signal queue for staggered processing
      const added = await this.signalQueue.addToQueue(signal, symbol, regime);

      if (added) {
        this.logger.log(
          `⚡📊 [Hour Swing] ${symbol} ${signal.direction} queued - ${signal.subStrategy}`,
          'DualStrategyOrchestrator',
        );
        this.positionManager.setCooldown(symbol, 'HOUR_SWING');
      } else {
        this.logger.debug(
          `[Hour Swing] ${symbol} already in queue, skipping duplicate`,
          'DualStrategyOrchestrator',
        );
      }
    } finally {
      // CRITICAL: Always remove from processing set
      this.processingSymbols.delete(symbol);
    }
  }

  /**
   * Process Box Range for a single symbol (event-driven)
   * Runs on same 15m timeframe as Cycle Rider, but lower priority
   */
  private async runBoxRangeForSymbol(
    symbol: string,
    regime: any,
    positions: any[],
  ): Promise<void> {
    // Early returns BEFORE adding to processingSymbols
    if (this.processingSymbols.has(symbol)) return;
    if (positions.some((p) => p.symbol === symbol)) return;

    if (
      await this.positionManager.isInCooldown(
        symbol,
        'BOX_RANGE',
        BOX_RANGE_CONFIG.position.cooldownMinutes,
      )
    ) {
      return;
    }

    const symbolRiskCheck = await this.riskManager.canOpenNewPosition(symbol, undefined);
    if (!symbolRiskCheck.allowed) return;

    // CRITICAL: Add to processingSymbols ONLY after all preconditions pass
    this.processingSymbols.add(symbol);

    try {
      // Get candles and current price from cache
      const candles = await this.cacheService.getRecentCandles(symbol, '15m', 100);

      // DEBUG: Log candle data retrieval
      this.logger.debug(
        `[BoxRange] ${symbol} Retrieved ${candles?.length || 0} candles from cache`,
        'DualStrategyOrchestrator',
      );

      if (!candles || candles.length < 50) {
        this.logger.debug(
          `[BoxRange] ${symbol} Insufficient candles: ${candles?.length || 0} (need 50+)`,
          'DualStrategyOrchestrator',
        );
        return;
      }

      const currentPrice = candles[candles.length - 1].close;

      // Get funding rate
      const fundingRate = await this.cacheService.getFundingRate(symbol);

      const signal = await this.boxRangeSignal.detect(symbol, candles, currentPrice, fundingRate);

      if (!signal?.detected) {
        return; // No signal detected
      }

      // CRITICAL: Centralized validation
      const validation = await this.validateLongSignal(signal, symbol, 'Box Range');
      if (!validation.allowed) {
        return; // Validation failed
      }

      this.logger.log(
        `⚡📊 [EVENT-DRIVEN Box Range] ${symbol} ${signal.direction} - ${signal.subStrategy} (Grade: ${signal.metadata?.boxGrade})`,
        'DualStrategyOrchestrator',
      );

      // Extract TP3 from metadata (Box Range has 3 TPs)
      const tp3Price = signal.metadata?.tp3Price;

      await this.orderExecutor.executeOrder({
        symbol,
        direction: signal.direction,
        strategyType: 'BOX_RANGE' as any,
        subStrategy: signal.subStrategy,
        entryPrice: signal.entryPrice,
        slPrice: signal.slPrice,
        tp1Price: signal.tp1Price,
        tp2Price: signal.tp2Price,
        leverage: signal.metadata?.leverage || BOX_RANGE_CONFIG.position.baseLeverage,
        marginUsd: signal.metadata?.marginUsd || BOX_RANGE_CONFIG.position.marginUsd,
        useTrailing: false,
        confidence: signal.confidence,
        marketRegime: regime,
        metadata: {
          ...signal.metadata,
          tp3Price, // Include TP3 for later use
        },
      });

      this.positionManager.setCooldown(symbol, 'BOX_RANGE');
    } finally {
      // CRITICAL: Always remove from processing set
      this.processingSymbols.delete(symbol);
    }
  }

  /**
   * Validate LONG signal with BTC Veto checks
   * CRITICAL: Centralized validation to prevent code duplication
   */
  private async validateLongSignal(
    signal: any,
    symbol: string,
    strategyType: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (signal.direction !== 'LONG') {
      return { allowed: true }; // No validation needed for SHORT
    }

    // 🚨 BTC Veto - Flash Crash Protection
    const flashCrash = await this.regimeClassifier.isFlashCrashActive();
    if (flashCrash.active) {
      this.logger.warn(
        `🚨 [BTC VETO] ${strategyType} LONG blocked for ${symbol}: ${flashCrash.reason}`,
        'DualStrategyOrchestrator',
      );
      return { allowed: false, reason: flashCrash.reason };
    }

    // 📊 Volatility Filter
    const volatility = await this.regimeClassifier.isVolatilityAcceptable(symbol);
    if (!volatility.acceptable) {
      this.logger.debug(
        `📊 [VOLATILITY FILTER] ${strategyType} LONG blocked for ${symbol}: ${volatility.reason}`,
        'DualStrategyOrchestrator',
      );
      return { allowed: false, reason: volatility.reason };
    }

    // 👑 BTC Dominance Check (only for altcoins)
    if (symbol !== 'BTCUSDT') {
      const dominance = await this.regimeClassifier.isBtcDominanceSurging();
      if (dominance.shouldReduceAltcoinLongs) {
        this.logger.warn(
          `👑 [BTC DOMINANCE] ${strategyType} altcoin LONG blocked for ${symbol}: BTC dominance surging`,
          'DualStrategyOrchestrator',
        );
        return { allowed: false, reason: 'BTC dominance surging' };
      }
    }

    return { allowed: true };
  }

  /**
   * Symbol Refresh - 아시아 세션 (09:40 KST)
   * 24시간 거래량 Top 100 심볼로 리프레시
   */
  @Cron('40 0 * * *', { timeZone: 'Asia/Seoul' }) // 09:40 KST = 00:40 UTC
  async refreshSymbolsAsiaSession(): Promise<void> {
    if (!this.isRunning) return;
    await this.executeSymbolRefresh('Asia (09:40 KST)');
  }

  /**
   * Symbol Refresh - 유럽 세션 (17:40 KST)
   */
  @Cron('40 8 * * *', { timeZone: 'Asia/Seoul' }) // 17:40 KST = 08:40 UTC
  async refreshSymbolsEuropeSession(): Promise<void> {
    if (!this.isRunning) return;
    await this.executeSymbolRefresh('Europe (17:40 KST)');
  }

  /**
   * Symbol Refresh - 미국 세션 (23:10 KST)
   * 미국 선물 마감 후 새 세션 시작에 맞춰 10분 지연
   */
  @Cron('10 14 * * *', { timeZone: 'Asia/Seoul' }) // 23:10 KST = 14:10 UTC
  async refreshSymbolsUSSession(): Promise<void> {
    if (!this.isRunning) return;
    await this.executeSymbolRefresh('US (23:10 KST)');
  }

  /**
   * Execute symbol refresh
   */
  private async executeSymbolRefresh(sessionName: string): Promise<void> {
    this.logger.log(
      `🔄 [Symbol Refresh] ${sessionName} session - refreshing symbol list...`,
      'DualStrategyOrchestrator',
    );

    try {
      // 1. Clear symbol cache to get fresh data
      this.symbolFetcher.clearCache();

      // 2. Fetch new top 100 symbols
      const newSymbols = await this.symbolFetcher.getTopSymbols(100);

      // 3. Get active positions to keep their symbols
      const positions = await this.positionManager.getActivePositions();
      const keepSymbols = positions.map(p => p.symbol);

      this.logger.log(
        `[Symbol Refresh] New symbols: ${newSymbols.length}, Active position symbols to keep: ${keepSymbols.length}`,
        'DualStrategyOrchestrator',
      );

      // 4. Refresh data collector with new symbols
      await this.dataCollector.refreshSymbols(newSymbols, keepSymbols);

      // 5. Update our internal symbols list
      this.symbols = this.dataCollector.getTrackedSymbols();

      // 6. Initialize funding rate history for new symbols
      await this.hourSwingSignal.initializeFundingHistory(this.symbols);

      this.logger.log(
        `✅ [Symbol Refresh] ${sessionName} complete. Now tracking ${this.symbols.length} symbols. Top 5: ${this.symbols.slice(0, 5).join(', ')}`,
        'DualStrategyOrchestrator',
      );

      await this.logger.logSystem({
        level: 'info',
        eventType: SystemEventType.DATA_COLLECTION_START,
        message: `Symbol refresh completed for ${sessionName}`,
        component: 'DualStrategyOrchestrator',
        metadata: {
          session: sessionName,
          totalSymbols: this.symbols.length,
          keptSymbols: keepSymbols.length,
          newSymbols: newSymbols.filter(s => !keepSymbols.includes(s)).length,
        },
      });
    } catch (error) {
      this.logger.error(
        `[Symbol Refresh] Failed for ${sessionName}: ${error.message}`,
        error.stack,
        'DualStrategyOrchestrator',
      );
    }
  }

  /**
   * Hourly Regime Update - 매 시간 정각에 레짐 재분류
   */
  @Cron('0 * * * *') // 매 시간 정각
  async updateRegimeHourly(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.log(
      '🔄 [Regime Update] Hourly regime classification running...',
      'DualStrategyOrchestrator',
    );

    try {
      const previousRegime = this.regimeClassifier.getCurrentRegime();
      const newRegime = await this.regimeClassifier.classifyRegime();

      if (previousRegime !== newRegime) {
        this.logger.log(
          `🔄 [Regime Update] Regime changed: ${previousRegime} → ${newRegime}`,
          'DualStrategyOrchestrator',
        );
      } else {
        this.logger.debug(
          `[Regime Update] Regime unchanged: ${newRegime}`,
          'DualStrategyOrchestrator',
        );
      }
    } catch (error) {
      this.logger.error(
        `[Regime Update] Failed: ${error.message}`,
        error.stack,
        'DualStrategyOrchestrator',
      );
    }
  }

  /**
   * Process Signal Queue - 2분마다 대기 중인 신호 처리
   * Staggered entry system to prevent concurrent entries
   */
  @Cron('*/2 * * * *') // Every 2 minutes
  async processSignalQueue(): Promise<void> {
    if (!this.isRunning) return;

    // Check if enough time has passed since last processing
    if (!this.signalQueue.canProcessNext()) {
      return;
    }

    // Get queue size
    const queueSize = await this.signalQueue.getQueueSize();
    if (queueSize === 0) {
      return;
    }

    this.logger.log(
      `[SignalQueue] 🔄 Processing queue (${queueSize} signals pending)`,
      'DualStrategyOrchestrator',
    );

    // Acquire processing lock
    if (!this.signalQueue.markProcessingStarted()) {
      this.logger.debug(
        '[SignalQueue] Already processing, skipping',
        'DualStrategyOrchestrator',
      );
      return;
    }

    try {
      // Get next signal from queue (highest priority first)
      const queuedSignal = await this.signalQueue.getNextSignal();
      if (!queuedSignal) {
        this.logger.debug(
          '[SignalQueue] No signal available after dequeue',
          'DualStrategyOrchestrator',
        );
        return;
      }

      const { signal, symbol, direction, regime } = queuedSignal;

      // Re-validate signal before entry
      const currentPrice = await this.cacheService.getCurrentPrice(symbol);
      if (!currentPrice) {
        this.logger.warn(
          `[SignalQueue] ${symbol} No current price, skipping`,
          'DualStrategyOrchestrator',
        );
        return;
      }

      const currentRegime = this.regimeClassifier.getCurrentRegime();
      const validation = await this.signalQueue.validateSignalForEntry(
        queuedSignal,
        currentPrice,
        currentRegime,
      );

      if (!validation.valid) {
        this.logger.log(
          `[SignalQueue] ${symbol} ❌ Re-validation failed: ${validation.reason}`,
          'DualStrategyOrchestrator',
        );
        return;
      }

      // Check regime-based concurrent entry limit
      const positions = await this.positionManager.getActivePositions();
      const sameDirectionCount = positions.filter(
        (p) => p.direction === direction,
      ).length;
      const maxConcurrent = this.signalQueue.getMaxConcurrentEntries(
        direction,
        currentRegime,
      );

      if (sameDirectionCount >= maxConcurrent) {
        this.logger.log(
          `[SignalQueue] ${symbol} ❌ Max concurrent ${direction} reached (${sameDirectionCount}/${maxConcurrent}) for regime ${currentRegime}`,
          'DualStrategyOrchestrator',
        );
        return;
      }

      // Check if symbol already has position
      if (positions.some((p) => p.symbol === symbol)) {
        this.logger.log(
          `[SignalQueue] ${symbol} ❌ Already has active position`,
          'DualStrategyOrchestrator',
        );
        return;
      }

      // Recalculate entry price based on current price
      const priceDiff = (currentPrice - signal.entryPrice) / signal.entryPrice;
      const adjustedSlPrice = signal.slPrice * (1 + priceDiff);
      const adjustedTp1Price = signal.tp1Price * (1 + priceDiff);
      const adjustedTp2Price = signal.tp2Price * (1 + priceDiff);

      this.logger.log(
        `[SignalQueue] ${symbol} ✅ Executing queued ${direction} signal @ ${currentPrice.toFixed(4)}`,
        'DualStrategyOrchestrator',
      );

      // Execute the order
      await this.orderExecutor.executeOrder({
        symbol,
        direction: signal.direction,
        strategyType: signal.strategyType,
        subStrategy: signal.subStrategy,
        entryPrice: currentPrice,
        slPrice: adjustedSlPrice,
        tp1Price: adjustedTp1Price,
        tp2Price: adjustedTp2Price,
        leverage: signal.metadata?.leverage || 15,
        marginUsd: signal.metadata?.marginUsd || 50,
        useTrailing: signal.useTrailing,
        confidence: signal.confidence,
        marketRegime: currentRegime,
        metadata: {
          ...signal.metadata,
          queuedAt: queuedSignal.createdAt,
          queueWaitMs: Date.now() - queuedSignal.createdAt,
          originalEntryPrice: signal.entryPrice,
        },
      });

      this.logger.log(
        `[SignalQueue] ${symbol} ⚡ Queued signal executed successfully`,
        'DualStrategyOrchestrator',
      );
    } catch (error) {
      this.logger.error(
        `[SignalQueue] Error processing queue: ${error.message}`,
        error.stack,
        'DualStrategyOrchestrator',
      );
    } finally {
      this.signalQueue.markProcessingCompleted();
    }
  }

  /**
   * Check Hour Swing concurrent entry limit
   * Prevents multiple entries within time window
   */
  private checkHourSwingConcurrentLimit(): { allowed: boolean; reason?: string } {
    if (!HOUR_SWING_CONFIG.concurrentEntryLimit?.enabled) {
      return { allowed: true };
    }

    const windowMs = HOUR_SWING_CONFIG.concurrentEntryLimit.windowMinutes * 60 * 1000;
    const maxEntries = HOUR_SWING_CONFIG.concurrentEntryLimit.maxEntriesWithinWindow;
    const now = Date.now();

    // Remove old timestamps outside the window
    this.hourSwingEntryTimestamps = this.hourSwingEntryTimestamps.filter(
      (ts) => now - ts < windowMs,
    );

    // Check if we've reached the limit
    if (this.hourSwingEntryTimestamps.length >= maxEntries) {
      const oldestEntry = Math.min(...this.hourSwingEntryTimestamps);
      const waitMinutes = Math.ceil((oldestEntry + windowMs - now) / 60000);
      return {
        allowed: false,
        reason: `${this.hourSwingEntryTimestamps.length} entries in last ${HOUR_SWING_CONFIG.concurrentEntryLimit.windowMinutes}min (max: ${maxEntries}), wait ~${waitMinutes}min`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check short-term momentum before entry
   * Returns true if momentum aligns with trade direction
   */
  async checkShortTermMomentum(direction: 'LONG' | 'SHORT'): Promise<{
    allowed: boolean;
    reason?: string;
    btcChange?: number;
  }> {
    try {
      // Get BTC last 4 hours of 1H candles
      const btcCandles = await this.cacheService.getRecentCandles('BTCUSDT', '1h', 4);

      if (!btcCandles || btcCandles.length < 4) {
        return { allowed: true }; // Not enough data, allow
      }

      // Calculate 4-hour price change
      const startPrice = btcCandles[0].open;
      const endPrice = btcCandles[btcCandles.length - 1].close;
      const btcChange = ((endPrice - startPrice) / startPrice) * 100;

      // Check if momentum aligns with direction
      if (direction === 'LONG' && btcChange < -1.0) {
        return {
          allowed: false,
          reason: `BTC 4H momentum negative (${btcChange.toFixed(2)}%), blocking LONG`,
          btcChange,
        };
      }

      if (direction === 'SHORT' && btcChange > 1.0) {
        return {
          allowed: false,
          reason: `BTC 4H momentum positive (+${btcChange.toFixed(2)}%), blocking SHORT`,
          btcChange,
        };
      }

      return { allowed: true, btcChange };
    } catch (error) {
      this.logger.error(
        `[Momentum Check] Error: ${error.message}`,
        error.stack,
        'DualStrategyOrchestrator',
      );
      return { allowed: true }; // On error, allow
    }
  }

  /**
   * Get system status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    symbols: string[];
    activePositions: number;
    currentRegime: any;
  }> {
    const positions = await this.positionManager.getActivePositions();
    const regime = this.regimeClassifier.getCurrentRegime();
    const volatilityCheck = await this.regimeClassifier.isVolatilityAcceptable();

    return {
      isRunning: this.isRunning,
      symbols: this.symbols,
      activePositions: positions.length,
      currentRegime: {
        regime,
        volatility: volatilityCheck.atrPercent,
      },
    };
  }
}
