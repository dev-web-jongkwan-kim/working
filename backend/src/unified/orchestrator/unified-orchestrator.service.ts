/**
 * Unified Orchestrator Service
 *
 * Replaces legacy dual-strategy orchestrator with unified strategy execution.
 * Uses the same PositionStateMachine and IActionExecutor as backtest,
 * ensuring 100% logic consistency between live trading and backtesting.
 *
 * Key features:
 * - CoreTrendStrategy (4H trigger) and SqueezeStrategy (15m trigger)
 * - Event-driven candle processing (< 0.1s reaction time)
 * - Unified position management via PositionStateMachine
 * - LiveActionExecutor for real order execution
 * - Funding cost tracking and calculation
 */

import { Injectable, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

// Entities
import { Trade, TradeStatus, StrategyType, CloseReason, TradeDirection } from '../../entities/trade.entity';
import { Position, PositionStatus } from '../../entities/position.entity';

// Core services
import { CustomLoggerService } from '../../common/logging/custom-logger.service';
import { SystemEventType } from '../../entities/system-log.entity';

// Data services
import { DataCollectorService } from '../../dual-strategy/services/data/data-collector.service';
import { DataCacheService } from '../../dual-strategy/services/data/data-cache.service';
import { SymbolFetcherService } from '../../dual-strategy/services/data/symbol-fetcher.service';
import { LiveDataAdapterAsync, DataSnapshot } from '../../adapters/live/live-data-adapter';

// Execution services
import { RiskManagerService } from '../../dual-strategy/services/execution/risk-manager.service';
import { PositionManagerService } from '../../dual-strategy/services/execution/position-manager.service';
import { OrderExecutorService } from '../../dual-strategy/services/execution/order-executor.service';

// Regime
import { MarketRegimeClassifierService } from '../../dual-strategy/services/regime/market-regime-classifier.service';

// Events
import { CandleClosedEvent } from '../../dual-strategy/events/candle-closed.event';

// New Strategy System
import {
  CoreTrendStrategy,
  SqueezeStrategy,
  FundingOverlay,
  TradingSignal,
} from '../../strategies/strategies.module';

// State Machine & Action Executor
import {
  PositionState,
  PositionEvent,
  PositionStateContext,
  ExitReason,
  createInitialContext,
  isPositionActive,
} from '../../strategies/core/state-machine/position-state';
import {
  processTransition,
  updateTrailingStop,
  TransitionAction,
} from '../../strategies/core/state-machine/state-transitions';
import { LiveActionExecutor } from '../../strategies/core/execution/live-action-executor';
import { PositionContext } from '../../strategies/core/execution/action-executor.interface';

/**
 * Active position tracking with state machine
 */
interface ActivePosition {
  /** State machine context */
  stateCtx: PositionStateContext;

  /** Execution context */
  execCtx: PositionContext;

  /** Database position record */
  position: Position;

  /** Original signal */
  signal: TradingSignal;

  /** Last update timestamp */
  lastUpdate: number;
}

/**
 * Strategy configuration
 */
const STRATEGY_CONFIG = {
  CORE_TREND: {
    maxPositions: 3,
    cooldownMinutes: 240, // 4 hours
    leverage: 10,
    marginUsd: 100,
    riskPerTrade: 0.005, // 0.5%
    timeframe: '4h',
  },
  SQUEEZE: {
    maxPositions: 3,
    cooldownMinutes: 60, // 1 hour
    leverage: 15,
    marginUsd: 75,
    riskPerTrade: 0.005, // 0.5%
    timeframe: '15m',
  },
};

@Injectable()
export class UnifiedOrchestratorService implements OnModuleInit {
  private isRunning = false;
  private symbols: string[] = [];
  private processingSymbols: Set<string> = new Set();
  private activePositions: Map<string, ActivePosition> = new Map();

  // Redis execution lock
  private readonly EXECUTION_LOCK_PREFIX = 'unified_execution_lock:';
  private readonly EXECUTION_LOCK_TTL_SECONDS = 60;

  // Strategies
  private coreTrendStrategy: CoreTrendStrategy;
  private squeezeStrategy: SqueezeStrategy;
  private fundingOverlay: FundingOverlay;

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    private readonly logger: CustomLoggerService,
    private readonly dataCollector: DataCollectorService,
    private readonly cacheService: DataCacheService,
    private readonly symbolFetcher: SymbolFetcherService,
    private readonly liveDataAdapter: LiveDataAdapterAsync,
    private readonly riskManager: RiskManagerService,
    private readonly positionManager: PositionManagerService,
    private readonly orderExecutor: OrderExecutorService,
    private readonly regimeClassifier: MarketRegimeClassifierService,
    private readonly actionExecutor: LiveActionExecutor,
  ) {
    // Initialize strategies
    this.coreTrendStrategy = new CoreTrendStrategy();
    this.squeezeStrategy = new SqueezeStrategy();
    this.fundingOverlay = new FundingOverlay();
  }

  async onModuleInit() {
    // Fetch top 100 symbols by volume
    this.symbols = await this.symbolFetcher.getTopSymbols(100);
    this.logger.log(
      `🎯 Unified Strategy System ready with ${this.symbols.length} symbols (Core Trend + Squeeze). Use API to start trading.`,
      'UnifiedOrchestrator',
    );
  }

  /**
   * Start the trading system
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('System already running', 'UnifiedOrchestrator');
      return;
    }

    this.isRunning = true;
    this.logger.log('🚀 Unified Strategy Trading System starting...', 'UnifiedOrchestrator');

    await this.logger.logSystem({
      level: 'info',
      eventType: SystemEventType.SYSTEM_START,
      message: 'Unified Strategy System started (Core Trend + Squeeze)',
      component: 'UnifiedOrchestrator',
      metadata: {
        symbols: this.symbols.slice(0, 10),
        symbolCount: this.symbols.length,
        strategies: ['CORE_TREND', 'SQUEEZE'],
      },
    });

    // Start data collection
    await this.dataCollector.startCollection(this.symbols);

    // Initial regime classification
    await this.regimeClassifier.classifyRegime();

    // Load existing positions into state machine
    await this.loadExistingPositions();

    this.logger.log(
      '✅ Unified System started successfully',
      'UnifiedOrchestrator',
    );
  }

  /**
   * Stop the trading system
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    this.logger.log('⏹️  Stopping Unified Strategy Trading System...', 'UnifiedOrchestrator');

    await this.logger.logSystem({
      level: 'info',
      eventType: SystemEventType.SYSTEM_STOP,
      message: 'Unified Strategy System stopped',
      component: 'UnifiedOrchestrator',
    });

    // Stop data collection
    await this.dataCollector.stopCollection();

    this.logger.log('System stopped', 'UnifiedOrchestrator');
  }

  /**
   * Load existing positions into state machine on startup
   */
  private async loadExistingPositions(): Promise<void> {
    const positions = await this.positionRepo.find({
      where: { status: PositionStatus.ACTIVE },
    });

    for (const position of positions) {
      // Only load new strategy positions
      if (position.strategy_type !== StrategyType.CORE_TREND &&
          position.strategy_type !== StrategyType.SQUEEZE) {
        continue;
      }

      // Calculate USD size from margin and leverage
      const marginUsd = Number(position.margin_usd);
      const initialSizeUsd = marginUsd * position.leverage;
      const positionSizeNum = Number(position.position_size);
      const remainingSizeNum = Number(position.remaining_size);
      const remainingSizeUsd = positionSizeNum > 0
        ? (remainingSizeNum / positionSizeNum) * initialSizeUsd
        : initialSizeUsd;

      const stateCtx: PositionStateContext = {
        state: position.tp1_filled ? PositionState.TRAILING : PositionState.IN_POSITION,
        symbol: position.symbol,
        strategyType: position.strategy_type,
        entryTime: position.entry_time.getTime(),
        entryPrice: Number(position.entry_price),
        positionSize: positionSizeNum,
        slPrice: Number(position.sl_price),
        tp1Price: position.tp1_price ? Number(position.tp1_price) : undefined,
        tp1Hit: position.tp1_filled || false,
        trailingStopPrice: position.trailing_stop_price ? Number(position.trailing_stop_price) : undefined,
        barsSinceEntry: 0,
        cooldownBars: 4,
      };

      const execCtx: PositionContext = {
        symbol: position.symbol,
        direction: position.direction as 'LONG' | 'SHORT',
        entryPrice: Number(position.entry_price),
        entryTime: position.entry_time.getTime(),
        initialSizeUsd,
        remainingSizeUsd,
        slPrice: Number(position.sl_price),
        tp1Price: position.tp1_price ? Number(position.tp1_price) : undefined,
        tp1Hit: position.tp1_filled || false,
        trailingStopPrice: position.trailing_stop_price ? Number(position.trailing_stop_price) : undefined,
        realizedPnl: Number(position.realized_pnl) || 0,
        fundingCost: 0,
        strategyType: position.strategy_type,
        tradeId: position.trade_id,
        leverage: position.leverage,
      };

      this.activePositions.set(position.symbol, {
        stateCtx,
        execCtx,
        position,
        signal: {} as TradingSignal, // Placeholder
        lastUpdate: Date.now(),
      });

      this.logger.log(
        `Loaded existing position: ${position.symbol} (${position.strategy_type})`,
        'UnifiedOrchestrator',
      );
    }

    this.logger.log(
      `Loaded ${this.activePositions.size} existing positions into state machine`,
      'UnifiedOrchestrator',
    );
  }

  /**
   * Acquire execution lock (Redis-based, atomic)
   */
  private async acquireExecutionLock(symbol: string): Promise<boolean> {
    const key = this.EXECUTION_LOCK_PREFIX + symbol;
    const result = await this.cacheService.client.set(key, Date.now().toString(), {
      EX: this.EXECUTION_LOCK_TTL_SECONDS,
      NX: true,
    });
    return result !== null;
  }

  /**
   * Release execution lock
   */
  private async releaseExecutionLock(symbol: string): Promise<void> {
    const key = this.EXECUTION_LOCK_PREFIX + symbol;
    await this.cacheService.client.del(key);
  }

  /**
   * Handle candle closed events
   * This is the primary entry point for strategy execution
   */
  @OnEvent('candle.closed')
  async handleCandleClosed(event: CandleClosedEvent): Promise<void> {
    if (!this.isRunning) return;
    if (!this.symbols.includes(event.symbol)) return;
    if (this.processingSymbols.has(event.symbol)) return;

    try {
      this.processingSymbols.add(event.symbol);

      // Update existing positions first
      await this.updatePosition(event.symbol, event.closePrice, event.closeTime);

      // Then check for new signals based on timeframe
      if (event.timeframe === '4h') {
        // Core Trend strategy
        await this.processCoreTrend(event.symbol);
      }

      if (event.timeframe === '15m') {
        // Squeeze strategy
        await this.processSqueeze(event.symbol);
      }

    } catch (error) {
      this.logger.error(
        `Error processing ${event.symbol} ${event.timeframe}: ${error.message}`,
        error.stack,
        'UnifiedOrchestrator',
      );
    } finally {
      this.processingSymbols.delete(event.symbol);
    }
  }

  /**
   * Process Core Trend strategy (4H timeframe)
   */
  private async processCoreTrend(symbol: string): Promise<void> {
    // Check if already has position
    if (this.activePositions.has(symbol)) return;

    // Check position limits
    const coreTrendCount = Array.from(this.activePositions.values())
      .filter(p => p.stateCtx.strategyType === 'CORE_TREND').length;
    if (coreTrendCount >= STRATEGY_CONFIG.CORE_TREND.maxPositions) return;

    // Check cooldown
    if (await this.positionManager.isInCooldown(
      symbol, 'CORE_TREND', STRATEGY_CONFIG.CORE_TREND.cooldownMinutes
    )) return;

    // Check risk
    const riskCheck = await this.riskManager.canOpenNewPosition(symbol, undefined);
    if (!riskCheck.allowed) return;

    // Create data snapshot for strategy
    const snapshot = await this.liveDataAdapter.createSnapshot(
      [symbol, 'BTCUSDT'],
      ['4h', '1d'],
    );

    // Generate signal
    const signal = this.coreTrendStrategy.generateSignal(symbol, snapshot);
    if (!signal?.detected) return;

    // Apply funding overlay
    const fundingRate = await this.cacheService.getFundingRate(symbol);
    const fundingHistory = this.liveDataAdapter.getFundingHistory(symbol, 200);
    const fundingResult = this.fundingOverlay.analyze(
      fundingRate || 0,
      fundingHistory,
      signal.direction,
    );

    if (fundingResult.action === 'BLOCK') {
      this.logger.debug(
        `[Core Trend] ${symbol} blocked by funding overlay`,
        'UnifiedOrchestrator',
      );
      return;
    }

    const finalSignal = this.fundingOverlay.applyToSignal(signal, fundingResult);
    if (!finalSignal) return;

    // Validate long signal
    const validation = await this.validateLongSignal(finalSignal, symbol, 'Core Trend');
    if (!validation.allowed) return;

    // Execute signal
    await this.executeSignal(finalSignal, 'CORE_TREND');
  }

  /**
   * Process Squeeze strategy (15m timeframe)
   */
  private async processSqueeze(symbol: string): Promise<void> {
    // Check if already has position
    if (this.activePositions.has(symbol)) return;

    // Check position limits
    const squeezeCount = Array.from(this.activePositions.values())
      .filter(p => p.stateCtx.strategyType === 'SQUEEZE').length;
    if (squeezeCount >= STRATEGY_CONFIG.SQUEEZE.maxPositions) return;

    // Check cooldown
    if (await this.positionManager.isInCooldown(
      symbol, 'SQUEEZE', STRATEGY_CONFIG.SQUEEZE.cooldownMinutes
    )) return;

    // Check risk
    const riskCheck = await this.riskManager.canOpenNewPosition(symbol, undefined);
    if (!riskCheck.allowed) return;

    // Create data snapshot for strategy
    const snapshot = await this.liveDataAdapter.createSnapshot(
      [symbol, 'BTCUSDT'],
      ['15m', '1h', '4h'],
    );

    // Generate signal
    const signal = this.squeezeStrategy.generateSignal(symbol, snapshot);
    if (!signal?.detected) return;

    // Apply funding overlay
    const fundingRate = await this.cacheService.getFundingRate(symbol);
    const fundingHistory = this.liveDataAdapter.getFundingHistory(symbol, 200);
    const fundingResult = this.fundingOverlay.analyze(
      fundingRate || 0,
      fundingHistory,
      signal.direction,
    );

    if (fundingResult.action === 'BLOCK') {
      this.logger.debug(
        `[Squeeze] ${symbol} blocked by funding overlay`,
        'UnifiedOrchestrator',
      );
      return;
    }

    const finalSignal = this.fundingOverlay.applyToSignal(signal, fundingResult);
    if (!finalSignal) return;

    // Validate long signal
    const validation = await this.validateLongSignal(finalSignal, symbol, 'Squeeze');
    if (!validation.allowed) return;

    // Execute signal
    await this.executeSignal(finalSignal, 'SQUEEZE');
  }

  /**
   * Execute a trading signal
   */
  private async executeSignal(
    signal: TradingSignal,
    strategyType: 'CORE_TREND' | 'SQUEEZE',
  ): Promise<void> {
    const symbol = signal.symbol || '';
    const config = STRATEGY_CONFIG[strategyType];

    // Acquire execution lock
    const lockAcquired = await this.acquireExecutionLock(symbol);
    if (!lockAcquired) {
      this.logger.warn(
        `[${strategyType}] ${symbol} execution lock not acquired`,
        'UnifiedOrchestrator',
      );
      return;
    }

    try {
      this.logger.log(
        `⚡ [${strategyType}] ${symbol} ${signal.direction} signal @ ${signal.entryPrice.toFixed(4)}`,
        'UnifiedOrchestrator',
      );

      const regime = this.regimeClassifier.getCurrentRegime();

      // Execute through order executor
      // Note: New strategies use trailing stop after TP1 instead of fixed TP2
      const result = await this.orderExecutor.executeOrder({
        symbol,
        direction: signal.direction,
        strategyType: strategyType as StrategyType,
        subStrategy: signal.subStrategy,
        entryPrice: signal.entryPrice,
        slPrice: signal.slPrice,
        tp1Price: signal.tp1Price,
        tp2Price: undefined, // New strategies use trailing stop instead of fixed TP2
        leverage: config.leverage,
        marginUsd: config.marginUsd,
        useTrailing: true,
        confidence: signal.confidence,
        marketRegime: regime,
        metadata: {
          ...signal.metadata,
          tp1QtyPercent: signal.tp1QtyPercent,
          trailAtrMult: signal.trailAtrMult,
          timeStopBars: signal.timeStopBars,
        },
      });

      if (result.success) {
        this.logger.log(
          `✅ [${strategyType}] ${symbol} order executed successfully`,
          'UnifiedOrchestrator',
        );

        // Set cooldown
        this.positionManager.setCooldown(symbol, strategyType);
      } else {
        this.logger.warn(
          `❌ [${strategyType}] ${symbol} order failed: ${result.error}`,
          'UnifiedOrchestrator',
        );
      }
    } finally {
      await this.releaseExecutionLock(symbol);
    }
  }

  /**
   * Update existing position using state machine
   */
  private async updatePosition(
    symbol: string,
    currentPrice: number,
    timestamp: number,
  ): Promise<void> {
    const activePos = this.activePositions.get(symbol);
    if (!activePos) return;

    const isLong = activePos.execCtx.direction === 'LONG';

    // Determine event based on current price
    const event = this.determinePositionEvent(activePos, currentPrice, timestamp);

    if (!event) {
      // No event, just update trailing stop if in TRAILING state
      if (activePos.stateCtx.state === PositionState.TRAILING) {
        const atr = (activePos.signal.metadata?.atr as number) || (activePos.execCtx.entryPrice * 0.02);
        const trailMult = activePos.signal.trailAtrMult || 2.5;
        const updatedCtx = updateTrailingStop(
          activePos.stateCtx,
          currentPrice,
          atr,
          trailMult,
          isLong ? 'LONG' : 'SHORT',
        );

        if (updatedCtx.trailingStopPrice !== activePos.stateCtx.trailingStopPrice) {
          activePos.stateCtx = updatedCtx;
          activePos.execCtx = await this.actionExecutor.updateTrailingStop(
            activePos.execCtx,
            updatedCtx.trailingStopPrice!,
          );

          // Update database
          await this.positionRepo.update(
            { id: activePos.position.id },
            { trailing_stop_price: updatedCtx.trailingStopPrice },
          );
        }
      }
      return;
    }

    // Process state transition
    const result = processTransition(activePos.stateCtx, event);
    activePos.stateCtx = result.context;

    // Execute actions
    for (const action of result.actions) {
      await this.executePositionAction(action, activePos, currentPrice);
    }

    // If position exited, remove from active positions
    if (activePos.stateCtx.state === PositionState.EXITED ||
        activePos.stateCtx.state === PositionState.COOLDOWN) {
      // Calculate final funding cost
      const fundingResult = await this.actionExecutor.calculateFundingCost(
        symbol,
        activePos.execCtx.initialSizeUsd,
        activePos.execCtx.entryTime,
        timestamp,
        isLong ? 'LONG' : 'SHORT',
      );

      const totalPnl = activePos.execCtx.realizedPnl - fundingResult.totalCost;

      // Update position status in database
      await this.positionRepo.update(
        { id: activePos.position.id },
        {
          status: PositionStatus.CLOSED,
          realized_pnl: totalPnl,
          remaining_size: 0,
        },
      );

      // Update trade with exit details (Trade entity has exit_price, exit_time, close_reason)
      if (activePos.execCtx.tradeId) {
        await this.tradeRepo.update(
          { trade_id: activePos.execCtx.tradeId },
          {
            status: TradeStatus.CLOSED,
            exit_price: currentPrice,
            exit_time: new Date(timestamp),
            pnl_usd: totalPnl,
            close_reason: this.mapExitReason(activePos.stateCtx.exitReason),
          },
        );
      }

      this.activePositions.delete(symbol);

      this.logger.log(
        `📊 [${activePos.stateCtx.strategyType}] ${symbol} position closed. PnL: $${totalPnl.toFixed(2)} (Funding: $${fundingResult.totalCost.toFixed(2)})`,
        'UnifiedOrchestrator',
      );
    }

    activePos.lastUpdate = Date.now();
  }

  /**
   * Determine which position event to fire
   */
  private determinePositionEvent(
    pos: ActivePosition,
    currentPrice: number,
    timestamp: number,
  ): PositionEvent | null {
    const isLong = pos.execCtx.direction === 'LONG';
    const slPrice = pos.execCtx.slPrice;
    const tp1Price = pos.execCtx.tp1Price;
    const trailingStop = pos.execCtx.trailingStopPrice;

    // Check SL hit
    if (isLong && currentPrice <= slPrice) {
      return PositionEvent.STOP_HIT;
    }
    if (!isLong && currentPrice >= slPrice) {
      return PositionEvent.STOP_HIT;
    }

    // Check trailing stop hit
    if (pos.stateCtx.state === PositionState.TRAILING && trailingStop) {
      if (isLong && currentPrice <= trailingStop) {
        return PositionEvent.TRAIL_HIT;
      }
      if (!isLong && currentPrice >= trailingStop) {
        return PositionEvent.TRAIL_HIT;
      }
    }

    // Check TP1 hit
    if (!pos.execCtx.tp1Hit && tp1Price) {
      if (isLong && currentPrice >= tp1Price) {
        return PositionEvent.TP1_HIT;
      }
      if (!isLong && currentPrice <= tp1Price) {
        return PositionEvent.TP1_HIT;
      }
    }

    // Check time stop
    if (pos.signal.timeStopBars) {
      const barDurationMs = pos.stateCtx.strategyType === 'CORE_TREND'
        ? 4 * 60 * 60 * 1000
        : 15 * 60 * 1000;
      const barsSinceEntry = Math.floor(
        (timestamp - pos.execCtx.entryTime) / barDurationMs,
      );

      if (barsSinceEntry >= pos.signal.timeStopBars) {
        return PositionEvent.TIME_STOP;
      }
    }

    return null;
  }

  /**
   * Execute a position action via LiveActionExecutor
   */
  private async executePositionAction(
    action: TransitionAction,
    pos: ActivePosition,
    currentPrice: number,
  ): Promise<void> {
    switch (action.type) {
      case 'CLOSE_PARTIAL': {
        const result = await this.actionExecutor.closePartial(
          pos.execCtx,
          action.percent,
          pos.execCtx.tp1Price || currentPrice,
          action.reason,
        );
        if (result.success) {
          pos.execCtx.realizedPnl += result.pnl;
          pos.execCtx.remainingSizeUsd -= result.closedSizeUsd;
          pos.execCtx.tp1Hit = true;

          // Update database - calculate remaining_size from ratio
          const remainingRatio = pos.execCtx.remainingSizeUsd / pos.execCtx.initialSizeUsd;
          const newRemainingSize = Number(pos.position.position_size) * remainingRatio;

          await this.positionRepo.update(
            { id: pos.position.id },
            {
              tp1_filled: true,
              remaining_size: newRemainingSize,
              realized_pnl: pos.execCtx.realizedPnl,
            },
          );

          this.logger.log(
            `[${pos.stateCtx.strategyType}] ${pos.execCtx.symbol} TP1 hit, closed ${action.percent}%. PnL: $${result.pnl.toFixed(2)}`,
            'UnifiedOrchestrator',
          );
        }
        break;
      }

      case 'MOVE_SL_TO_BREAKEVEN': {
        pos.execCtx = await this.actionExecutor.moveSLToBreakeven(pos.execCtx);
        await this.positionRepo.update(
          { id: pos.position.id },
          { sl_price: pos.execCtx.slPrice },
        );
        this.logger.log(
          `[${pos.stateCtx.strategyType}] ${pos.execCtx.symbol} SL moved to breakeven @ ${pos.execCtx.slPrice}`,
          'UnifiedOrchestrator',
        );
        break;
      }

      case 'UPDATE_SL_ON_EXCHANGE': {
        await this.actionExecutor.updateSLOnExchange(pos.execCtx, action.price);
        break;
      }

      case 'UPDATE_TRAILING_STOP': {
        pos.execCtx = await this.actionExecutor.updateTrailingStop(
          pos.execCtx,
          action.price,
        );
        await this.positionRepo.update(
          { id: pos.position.id },
          { trailing_stop_price: action.price },
        );
        break;
      }

      case 'CLOSE_ALL': {
        const result = await this.actionExecutor.closeAll(
          pos.execCtx,
          currentPrice,
          action.reason.toString(),
        );
        if (result.success) {
          pos.execCtx.realizedPnl += result.pnl;
          pos.execCtx.remainingSizeUsd = 0;
        }
        break;
      }

      case 'START_COOLDOWN':
        this.positionManager.setCooldown(
          pos.execCtx.symbol,
          pos.stateCtx.strategyType,
        );
        break;

      case 'LOG':
        this.logger.debug(action.message, 'UnifiedOrchestrator');
        break;
    }
  }

  /**
   * Validate LONG signal with BTC Veto checks
   */
  private async validateLongSignal(
    signal: TradingSignal,
    symbol: string,
    strategyType: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (signal.direction !== 'LONG') {
      return { allowed: true };
    }

    // BTC Veto - Flash Crash Protection
    const flashCrash = await this.regimeClassifier.isFlashCrashActive();
    if (flashCrash.active) {
      this.logger.warn(
        `🚨 [BTC VETO] ${strategyType} LONG blocked for ${symbol}: ${flashCrash.reason}`,
        'UnifiedOrchestrator',
      );
      return { allowed: false, reason: flashCrash.reason };
    }

    // Volatility Filter
    const volatility = await this.regimeClassifier.isVolatilityAcceptable(symbol);
    if (!volatility.acceptable) {
      this.logger.debug(
        `📊 [VOLATILITY FILTER] ${strategyType} LONG blocked for ${symbol}: ${volatility.reason}`,
        'UnifiedOrchestrator',
      );
      return { allowed: false, reason: volatility.reason };
    }

    // BTC Dominance Check (only for altcoins)
    if (symbol !== 'BTCUSDT') {
      const dominance = await this.regimeClassifier.isBtcDominanceSurging();
      if (dominance.shouldReduceAltcoinLongs) {
        this.logger.warn(
          `👑 [BTC DOMINANCE] ${strategyType} altcoin LONG blocked for ${symbol}: BTC dominance surging`,
          'UnifiedOrchestrator',
        );
        return { allowed: false, reason: 'BTC dominance surging' };
      }
    }

    return { allowed: true };
  }

  /**
   * Map ExitReason to CloseReason
   */
  private mapExitReason(exitReason?: ExitReason): CloseReason {
    if (!exitReason) return CloseReason.MANUAL;

    switch (exitReason) {
      case ExitReason.STOP_LOSS:
        return CloseReason.STOP_LOSS;
      case ExitReason.TP1:
        return CloseReason.TP1;
      case ExitReason.TP2:
        return CloseReason.TP2;
      case ExitReason.TRAILING_STOP:
        return CloseReason.TRAILING_STOP;
      case ExitReason.TIME_STOP:
        return CloseReason.TIME_BASED;
      case ExitReason.OPPOSITE_SIGNAL:
        return CloseReason.MANUAL; // Map to MANUAL since OPPOSITE_SIGNAL doesn't exist
      case ExitReason.MANUAL:
        return CloseReason.MANUAL;
      case ExitReason.RISK_LIMIT:
        return CloseReason.EMERGENCY_CLOSE;
      case ExitReason.LIQUIDATION:
        return CloseReason.FORCED_CLOSE_OR_LIQUIDATION;
      default:
        return CloseReason.MANUAL;
    }
  }

  /**
   * Hourly regime update
   */
  @Cron('0 * * * *')
  async updateRegimeHourly(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const previousRegime = this.regimeClassifier.getCurrentRegime();
      const newRegime = await this.regimeClassifier.classifyRegime();

      if (previousRegime !== newRegime) {
        this.logger.log(
          `🔄 [Regime Update] Regime changed: ${previousRegime} → ${newRegime}`,
          'UnifiedOrchestrator',
        );
      }
    } catch (error) {
      this.logger.error(
        `[Regime Update] Failed: ${error.message}`,
        error.stack,
        'UnifiedOrchestrator',
      );
    }
  }

  /**
   * Get system status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    symbols: number;
    activePositions: number;
    positionsByStrategy: Record<string, number>;
    currentRegime: any;
  }> {
    const regime = this.regimeClassifier.getCurrentRegime();

    const positionsByStrategy: Record<string, number> = {
      CORE_TREND: 0,
      SQUEEZE: 0,
    };

    for (const pos of this.activePositions.values()) {
      positionsByStrategy[pos.stateCtx.strategyType]++;
    }

    return {
      isRunning: this.isRunning,
      symbols: this.symbols.length,
      activePositions: this.activePositions.size,
      positionsByStrategy,
      currentRegime: regime,
    };
  }

  /**
   * Manual scan trigger
   */
  async runManualScan(): Promise<{
    scannedSymbols: number;
    signalsGenerated: number;
    errors: string[];
  }> {
    if (!this.isRunning) {
      throw new Error('System is not running. Start the system first.');
    }

    const results = {
      scannedSymbols: 0,
      signalsGenerated: 0,
      errors: [] as string[],
    };

    this.logger.log('🔄 [Manual Scan] Starting...', 'UnifiedOrchestrator');

    for (const symbol of this.symbols) {
      if (this.activePositions.has(symbol)) continue;

      try {
        results.scannedSymbols++;

        // Check Core Trend
        await this.processCoreTrend(symbol);

        // Check Squeeze
        await this.processSqueeze(symbol);
      } catch (error) {
        results.errors.push(`${symbol}: ${error.message}`);
      }
    }

    this.logger.log(
      `✅ [Manual Scan] Completed: ${results.scannedSymbols} symbols scanned`,
      'UnifiedOrchestrator',
    );

    return results;
  }
}
