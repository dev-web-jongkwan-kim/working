import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CustomLoggerService } from '../../common/logging/custom-logger.service';
import { BinanceDataDownloaderService, Candle } from './binance-data-downloader.service';
import { BacktestRun, BacktestStatus } from '../entities/backtest-run.entity';
import {
  BacktestTrade,
  TradeDirection,
  TradeStatus,
  CloseReason,
} from '../entities/backtest-trade.entity';

// New Strategy System (improve.md 기반)
import {
  CoreTrendStrategy,
  SqueezeStrategy,
  FundingOverlay,
  TradingSignal,
} from '../../strategies/strategies.module';
import {
  BacktestDataAdapter,
  createBacktestAdapter,
} from '../../adapters/backtest/backtest-data-adapter';
import { MarketRegime } from '../../entities/market-regime-history.entity';

// State Machine & Action Executor (unified with live trading)
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
import {
  BacktestActionExecutor,
  BacktestDataSource,
} from '../../strategies/core/execution/backtest-action-executor';
import { PositionContext } from '../../strategies/core/execution/action-executor.interface';

/**
 * Extended position state for backtest with trade tracking
 */
interface BacktestPosition {
  /** State machine context */
  stateCtx: PositionStateContext;

  /** Action executor context */
  execCtx: PositionContext;

  /** Database trade record */
  trade: BacktestTrade;

  /** Original signal */
  signal: TradingSignal;
}

@Injectable()
export class BacktestEngineService {
  private readonly COMMISSION_RATE = 0.0005; // 0.05% (maker/taker 평균)
  private readonly SLIPPAGE_RATE = 0.0001;   // 0.01%

  // New strategies only (improve.md)
  private coreTrendStrategy: CoreTrendStrategy;
  private squeezeStrategy: SqueezeStrategy;
  private fundingOverlay: FundingOverlay;

  constructor(
    @InjectRepository(BacktestRun)
    private readonly backtestRunRepo: Repository<BacktestRun>,
    @InjectRepository(BacktestTrade)
    private readonly backtestTradeRepo: Repository<BacktestTrade>,
    private readonly downloader: BinanceDataDownloaderService,
    private readonly logger: CustomLoggerService,
  ) {
    // Initialize new strategies only
    this.coreTrendStrategy = new CoreTrendStrategy();
    this.squeezeStrategy = new SqueezeStrategy();
    this.fundingOverlay = new FundingOverlay();
  }

  async runBacktest(backtestRunId: string): Promise<void> {
    const run = await this.backtestRunRepo.findOne({
      where: { id: backtestRunId },
    });

    if (!run) {
      throw new Error('Backtest run not found');
    }

    // Only allow new strategies (improve.md)
    const validStrategies = ['CORE_TREND', 'SQUEEZE'];
    const hasValidStrategy = run.strategies.some(s => validStrategies.includes(s));

    if (!hasValidStrategy) {
      throw new Error('Only CORE_TREND and SQUEEZE strategies are supported. Legacy strategies are disabled.');
    }

    try {
      // Update status
      run.status = BacktestStatus.DOWNLOADING;
      await this.backtestRunRepo.save(run);

      // Download data (4H/1D for Core Trend, 1H/15m for Squeeze)
      const candleData = await this.downloadAllData(run);
      const fundingData = await this.downloadFundingData(run);

      // Update status
      run.status = BacktestStatus.RUNNING;
      run.progress = 0;
      await this.backtestRunRepo.save(run);

      // Run simulation using unified state machine
      await this.simulate(run, candleData, fundingData);

      // Calculate final metrics
      await this.calculateMetrics(run);

      // Update status
      run.status = BacktestStatus.COMPLETED;
      run.progress = 100;
      await this.backtestRunRepo.save(run);

      this.logger.log(
        `Backtest ${run.id} completed: ${run.totalTrades} trades, PnL: $${run.totalPnl}`,
        'BacktestEngine',
      );
    } catch (error) {
      run.status = BacktestStatus.FAILED;
      run.errorMessage = error.message;
      await this.backtestRunRepo.save(run);
      this.logger.error(`Backtest ${run.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async downloadAllData(run: BacktestRun): Promise<Map<string, Candle[]>> {
    const candleData = new Map<string, Candle[]>();
    const timeframes = ['15m', '1h', '4h', '1d'];
    const symbolsToDownload = [...run.symbols];

    // Always include BTCUSDT for relative strength
    if (!symbolsToDownload.includes('BTCUSDT')) {
      symbolsToDownload.push('BTCUSDT');
    }

    for (const symbol of symbolsToDownload) {
      for (const timeframe of timeframes) {
        run.currentStep = `Downloading ${symbol} ${timeframe}`;
        await this.backtestRunRepo.save(run);

        const candles = await this.downloader.downloadData(
          symbol,
          timeframe,
          run.startDate,
          run.endDate,
          (progress, message) => {
            run.progress = Math.round(progress * 0.3);
            run.currentStep = message;
          },
        );

        candleData.set(`${symbol}_${timeframe}`, candles);
      }
    }

    return candleData;
  }

  private async downloadFundingData(run: BacktestRun): Promise<Map<string, number[]>> {
    const fundingData = new Map<string, number[]>();

    for (const symbol of run.symbols) {
      run.currentStep = `Downloading ${symbol} funding rates`;
      await this.backtestRunRepo.save(run);

      const rates = await this.downloader.downloadFundingHistory(
        symbol,
        run.startDate,
        run.endDate,
      );

      fundingData.set(symbol, rates);
    }

    return fundingData;
  }

  /**
   * Main simulation loop using unified PositionStateMachine
   *
   * This now uses the same state machine and action executor pattern as live trading,
   * ensuring 100% logic consistency between backtest and live environments.
   */
  private async simulate(
    run: BacktestRun,
    candleData: Map<string, Candle[]>,
    fundingData: Map<string, number[]>,
  ): Promise<void> {
    // Create backtest data adapter
    const adapter = createBacktestAdapter(
      candleData as any,
      fundingData,
      run.symbols,
    );

    // Create data source wrapper for action executor
    const dataSource: BacktestDataSource = {
      getCurrentPrice: (symbol: string) => adapter.getCurrentPrice(symbol),
      getFundingHistory: (symbol: string, count: number) => adapter.getFundingHistory(symbol, count),
      getCurrentTime: () => adapter.getCurrentTime(),
    };

    // Create action executor (same interface as live, different implementation)
    const actionExecutor = new BacktestActionExecutor(dataSource, {
      commissionRate: this.COMMISSION_RATE,
      slippageRate: this.SLIPPAGE_RATE,
    });

    const openPositions = new Map<string, BacktestPosition>();
    let balance = Number(run.initialBalance);

    // Get all unique timestamps from 4H and 15m candles
    const timestamps = new Set<number>();
    for (const [key, candles] of candleData.entries()) {
      if (key.endsWith('_4h') || key.endsWith('_15m')) {
        candles.forEach((c) => timestamps.add(c.closeTime));
      }
    }

    const sortedTimestamps = Array.from(timestamps).sort((a, b) => a - b);
    const totalSteps = sortedTimestamps.length;

    this.logger.log(
      `Simulating ${totalSteps} time steps for ${run.symbols.length} symbols using unified state machine`,
      'BacktestEngine',
    );

    for (let i = 0; i < sortedTimestamps.length; i++) {
      const timestamp = sortedTimestamps[i];
      adapter.setCurrentTime(timestamp);

      // Update progress
      if (i % 100 === 0) {
        run.progress = 30 + Math.round((i / totalSteps) * 60);
        run.currentStep = `Processing ${new Date(timestamp).toISOString().split('T')[0]}`;
        await this.backtestRunRepo.save(run);
      }

      // ========== Process open positions using state machine ==========
      for (const [posKey, pos] of openPositions.entries()) {
        const symbol = pos.trade.symbol;
        const currentPrice = adapter.getCurrentPrice(symbol);
        if (!currentPrice) continue;

        const isLong = pos.trade.direction === TradeDirection.LONG;

        // Determine which event to fire based on current price
        const event = this.determinePositionEvent(pos, currentPrice, timestamp);
        if (!event) {
          // No event, just update trailing stop if applicable
          if (pos.stateCtx.state === PositionState.TRAILING) {
            const atr = (pos.signal.metadata?.atr as number) || (Number(pos.trade.entryPrice) * 0.02);
            const trailMult = pos.signal.trailAtrMult || 2.5;
            const updatedCtx = updateTrailingStop(
              pos.stateCtx,
              currentPrice,
              atr,
              trailMult,
              isLong ? 'LONG' : 'SHORT',
            );
            pos.stateCtx = updatedCtx;

            // Also update execution context
            if (updatedCtx.trailingStopPrice !== pos.execCtx.trailingStopPrice) {
              pos.execCtx = await actionExecutor.updateTrailingStop(pos.execCtx, updatedCtx.trailingStopPrice!);
            }
          }
          continue;
        }

        // Process state transition
        const result = processTransition(pos.stateCtx, event);
        pos.stateCtx = result.context;

        // Execute actions from state machine
        for (const action of result.actions) {
          await this.executeAction(action, pos, actionExecutor, currentPrice, balance, (pnl) => {
            balance += pnl;
          });
        }

        // If position exited, save trade and remove from map
        if (pos.stateCtx.state === PositionState.EXITED || pos.stateCtx.state === PositionState.COOLDOWN) {
          // Calculate final funding cost
          const fundingResult = await actionExecutor.calculateFundingCost(
            symbol,
            pos.execCtx.initialSizeUsd,
            pos.execCtx.entryTime,
            timestamp,
            isLong ? 'LONG' : 'SHORT',
          );

          const totalPnl = pos.execCtx.realizedPnl - fundingResult.totalCost;

          pos.trade.exitPrice = currentPrice;
          pos.trade.exitTime = new Date(timestamp);
          pos.trade.status = TradeStatus.CLOSED;
          pos.trade.closeReason = this.mapExitReason(pos.stateCtx.exitReason);
          pos.trade.pnlUsd = totalPnl;
          pos.trade.pnlPercent = (totalPnl / pos.execCtx.initialSizeUsd) * 100;
          pos.trade.metadata = {
            ...pos.trade.metadata,
            tp1Hit: pos.execCtx.tp1Hit,
            realizedAtTp1: pos.execCtx.tp1Hit ? pos.execCtx.realizedPnl : 0,
            fundingCost: fundingResult.totalCost,
            fundingPeriods: fundingResult.periods,
          };

          await this.backtestTradeRepo.save(pos.trade);
          openPositions.delete(posKey);
        }
      }

      // ========== Generate signals ==========
      for (const symbol of run.symbols) {
        const posKey = symbol;
        if (openPositions.has(posKey)) continue;
        if (openPositions.size >= 5) continue; // max_open_positions_total: 5

        let signal: TradingSignal | null = null;

        // Core Trend (4H trigger)
        if (run.strategies.includes('CORE_TREND') && !signal) {
          signal = this.coreTrendStrategy.generateSignal(symbol, adapter);
        }

        // Squeeze (15m trigger)
        if (run.strategies.includes('SQUEEZE') && !signal) {
          signal = this.squeezeStrategy.generateSignal(symbol, adapter);
        }

        if (signal && signal.detected) {
          // Apply funding overlay
          const fundingRate = adapter.getFundingRate(symbol);
          const fundingHistory = adapter.getFundingHistory(symbol, 200);
          const fundingResult = this.fundingOverlay.analyze(
            fundingRate,
            fundingHistory,
            signal.direction,
          );

          // Skip if blocked
          if (fundingResult.action === 'BLOCK') continue;

          // Apply tightening if needed
          const finalSignal = this.fundingOverlay.applyToSignal(signal, fundingResult);
          if (!finalSignal) continue;

          // Volatility-based sizing (improve.md: 0.5% risk per trade)
          const riskPerTrade = balance * 0.005;
          const stopDistance = Math.abs(finalSignal.entryPrice - finalSignal.slPrice);
          const positionSizeUsd = stopDistance > 0
            ? riskPerTrade / (stopDistance / finalSignal.entryPrice)
            : 0;

          if (positionSizeUsd < 100) continue; // Min position

          // Create position using state machine
          const position = await this.openPositionWithStateMachine(
            run,
            symbol,
            finalSignal,
            positionSizeUsd,
            timestamp,
          );

          openPositions.set(posKey, position);
        }
      }
    }

    // Close remaining positions at end
    for (const [posKey, pos] of openPositions.entries()) {
      const symbol = pos.trade.symbol;
      const currentPrice = adapter.getCurrentPrice(symbol);
      if (!currentPrice) continue;

      const isLong = pos.trade.direction === TradeDirection.LONG;
      const closeResult = await actionExecutor.closeAll(pos.execCtx, currentPrice, 'END_OF_BACKTEST');

      pos.trade.exitPrice = closeResult.exitPrice;
      pos.trade.exitTime = new Date(sortedTimestamps[sortedTimestamps.length - 1]);
      pos.trade.status = TradeStatus.CLOSED;
      pos.trade.closeReason = CloseReason.END_OF_BACKTEST;
      pos.trade.pnlUsd = pos.execCtx.realizedPnl + closeResult.pnl;
      pos.trade.pnlPercent = ((pos.execCtx.realizedPnl + closeResult.pnl) / pos.execCtx.initialSizeUsd) * 100;
      pos.trade.metadata = {
        ...pos.trade.metadata,
        tp1Hit: pos.execCtx.tp1Hit,
      };

      await this.backtestTradeRepo.save(pos.trade);
      balance += closeResult.pnl;
    }
  }

  /**
   * Determine which position event to fire based on current price
   */
  private determinePositionEvent(
    pos: BacktestPosition,
    currentPrice: number,
    timestamp: number,
  ): PositionEvent | null {
    const isLong = pos.trade.direction === TradeDirection.LONG;
    const entryPrice = Number(pos.trade.entryPrice);
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

    // Check trailing stop hit (if in TRAILING state)
    if (pos.stateCtx.state === PositionState.TRAILING && trailingStop) {
      if (isLong && currentPrice <= trailingStop) {
        return PositionEvent.TRAIL_HIT;
      }
      if (!isLong && currentPrice >= trailingStop) {
        return PositionEvent.TRAIL_HIT;
      }
    }

    // Check TP1 hit (if not already hit)
    if (!pos.execCtx.tp1Hit && tp1Price) {
      if (isLong && currentPrice >= tp1Price) {
        return PositionEvent.TP1_HIT;
      }
      if (!isLong && currentPrice <= tp1Price) {
        return PositionEvent.TP1_HIT;
      }
    }

    // Check time stop
    if (pos.signal.timeStopBars && pos.trade.entryTime) {
      const barDurationMs = pos.signal.strategyType === 'CORE_TREND'
        ? 4 * 60 * 60 * 1000
        : 15 * 60 * 1000;
      const barsSinceEntry = Math.floor((timestamp - pos.trade.entryTime.getTime()) / barDurationMs);

      if (barsSinceEntry >= pos.signal.timeStopBars) {
        return PositionEvent.TIME_STOP;
      }
    }

    return null;
  }

  /**
   * Execute a transition action
   */
  private async executeAction(
    action: TransitionAction,
    pos: BacktestPosition,
    executor: BacktestActionExecutor,
    currentPrice: number,
    balance: number,
    onPnl: (pnl: number) => void,
  ): Promise<void> {
    switch (action.type) {
      case 'CLOSE_PARTIAL': {
        const result = await executor.closePartial(
          pos.execCtx,
          action.percent,
          pos.execCtx.tp1Price || currentPrice,
          action.reason,
        );
        if (result.success) {
          pos.execCtx.realizedPnl += result.pnl;
          pos.execCtx.remainingSizeUsd -= result.closedSizeUsd;
          pos.execCtx.tp1Hit = true;
          onPnl(result.pnl);
        }
        break;
      }

      case 'MOVE_SL_TO_BREAKEVEN': {
        pos.execCtx = await executor.moveSLToBreakeven(pos.execCtx);
        pos.trade.slPrice = pos.execCtx.slPrice;
        break;
      }

      case 'UPDATE_TRAILING_STOP': {
        pos.execCtx = await executor.updateTrailingStop(pos.execCtx, action.price);
        break;
      }

      case 'UPDATE_SL_ON_EXCHANGE': {
        // In backtest, this is just a local update
        pos.execCtx.slPrice = action.price;
        break;
      }

      case 'CLOSE_ALL': {
        const result = await executor.closeAll(pos.execCtx, currentPrice, action.reason.toString());
        if (result.success) {
          pos.execCtx.realizedPnl += result.pnl;
          pos.execCtx.remainingSizeUsd = 0;
          onPnl(result.pnl);
        }
        break;
      }

      case 'START_COOLDOWN':
      case 'LOG':
      case 'CALCULATE_FUNDING_COST':
        // These don't require executor actions
        break;

      default:
        // Ignore other actions (PLACE_ENTRY_ORDER, etc.)
        break;
    }
  }

  /**
   * Open a position using state machine pattern
   */
  private async openPositionWithStateMachine(
    run: BacktestRun,
    symbol: string,
    signal: TradingSignal,
    positionSizeUsd: number,
    timestamp: number,
  ): Promise<BacktestPosition> {
    const isLong = signal.direction === 'LONG';
    const entryPrice = signal.entryPrice * (1 + this.SLIPPAGE_RATE * (isLong ? 1 : -1));
    const leverage = (signal.metadata?.leverage as number) || 10;
    const marginUsd = positionSizeUsd / leverage;
    const positionSize = positionSizeUsd / entryPrice;

    // Create database trade record
    const trade = this.backtestTradeRepo.create({
      backtest_run_id: run.id,
      symbol,
      strategy: signal.strategyType,
      subStrategy: signal.subStrategy,
      direction: isLong ? TradeDirection.LONG : TradeDirection.SHORT,
      entryPrice,
      slPrice: signal.slPrice,
      tp1Price: signal.tp1Price,
      tp2Price: undefined,
      leverage,
      marginUsd,
      positionSize,
      entryTime: new Date(timestamp),
      status: TradeStatus.OPEN,
      signalConfidence: signal.confidence,
      marketRegime: MarketRegime.SIDEWAYS,
      metadata: {
        signalDetails: signal.metadata,
        tp1QtyPercent: signal.tp1QtyPercent,
        trailAtrMult: signal.trailAtrMult,
        timeStopBars: signal.timeStopBars,
        fundingAction: signal.fundingAction,
      },
    });

    const savedTrade = await this.backtestTradeRepo.save(trade);

    // Create state machine context
    const stateCtx: PositionStateContext = {
      state: PositionState.IN_POSITION,
      symbol,
      strategyType: signal.strategyType,
      entryTime: timestamp,
      entryPrice,
      positionSize,
      slPrice: signal.slPrice,
      tp1Price: signal.tp1Price,
      tp1Hit: false,
      barsSinceEntry: 0,
      cooldownBars: 4,
      timeStopBars: signal.timeStopBars,
    };

    // Create execution context
    const execCtx: PositionContext = {
      symbol,
      direction: signal.direction,
      entryPrice,
      entryTime: timestamp,
      initialSizeUsd: positionSizeUsd,
      remainingSizeUsd: positionSizeUsd,
      slPrice: signal.slPrice,
      tp1Price: signal.tp1Price,
      tp1Hit: false,
      realizedPnl: 0,
      fundingCost: 0,
      strategyType: signal.strategyType,
      tradeId: savedTrade.id,
      leverage,
      metadata: signal.metadata,
    };

    return {
      stateCtx,
      execCtx,
      trade: savedTrade,
      signal,
    };
  }

  /**
   * Map ExitReason from state machine to CloseReason for DB
   */
  private mapExitReason(exitReason?: ExitReason): CloseReason {
    if (!exitReason) return CloseReason.END_OF_BACKTEST;

    switch (exitReason) {
      case ExitReason.STOP_LOSS:
        return CloseReason.SL;
      case ExitReason.TP1:
        return CloseReason.TP1;
      case ExitReason.TP2:
        return CloseReason.TP2;
      case ExitReason.TRAILING_STOP:
        return CloseReason.TRAILING_SL;
      case ExitReason.TIME_STOP:
        return CloseReason.TIME_BASED;
      case ExitReason.OPPOSITE_SIGNAL:
        return CloseReason.OPPOSITE_SIGNAL;
      case ExitReason.MANUAL:
        return CloseReason.MANUAL;
      case ExitReason.RISK_LIMIT:
        return CloseReason.EMERGENCY;
      case ExitReason.LIQUIDATION:
        return CloseReason.LIQUIDATION;
      default:
        return CloseReason.END_OF_BACKTEST;
    }
  }

  private async calculateMetrics(run: BacktestRun): Promise<void> {
    const trades = await this.backtestTradeRepo.find({
      where: { backtest_run_id: run.id, status: TradeStatus.CLOSED },
      order: { exitTime: 'ASC' },
    });

    if (trades.length === 0) {
      run.totalTrades = 0;
      run.winningTrades = 0;
      run.losingTrades = 0;
      run.winRate = 0;
      run.totalPnl = 0;
      run.totalPnlPercent = 0;
      run.finalBalance = Number(run.initialBalance);
      run.maxDrawdown = 0;
      run.sharpeRatio = 0;
      run.profitFactor = 0;
      return;
    }

    const winningTrades = trades.filter((t) => Number(t.pnlUsd) > 0);
    const losingTrades = trades.filter((t) => Number(t.pnlUsd) <= 0);
    const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnlUsd), 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + Number(t.pnlUsd), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + Number(t.pnlUsd), 0));

    // Calculate drawdown
    let peak = Number(run.initialBalance);
    let maxDrawdown = 0;
    let balance = Number(run.initialBalance);

    for (const trade of trades) {
      balance += Number(trade.pnlUsd);
      if (balance > peak) peak = balance;
      const drawdown = ((peak - balance) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Calculate Sharpe Ratio
    const returns = trades.map((t) => Number(t.pnlPercent));
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const stdDev = Math.sqrt(
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length,
    );
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    run.totalTrades = trades.length;
    run.winningTrades = winningTrades.length;
    run.losingTrades = losingTrades.length;
    run.winRate = (winningTrades.length / trades.length) * 100;
    run.totalPnl = totalPnl;
    run.totalPnlPercent = (totalPnl / Number(run.initialBalance)) * 100;
    run.finalBalance = Number(run.initialBalance) + totalPnl;
    run.maxDrawdown = maxDrawdown;
    run.sharpeRatio = sharpeRatio;
    run.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    await this.backtestRunRepo.save(run);
  }
}
