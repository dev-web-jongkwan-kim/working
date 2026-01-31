import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Trade, TradeStatus, CloseReason, StrategyType } from '../../../entities/trade.entity';
import { Position, PositionStatus } from '../../../entities/position.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { TradingWebSocketGateway } from '../../../websocket/websocket.gateway';
import { DataCacheService } from '../data/data-cache.service';
import { RiskManagerService } from './risk-manager.service';
import { BinanceService } from '../data/binance.service';
import { EventType } from '../../../entities/strategy-log.entity';

/**
 * Legacy strategy trailing stop config (for backwards compatibility)
 * Note: Legacy strategies are deprecated. Use UnifiedOrchestratorService for CORE_TREND/SQUEEZE.
 */
const LEGACY_TRAILING_CONFIG = {
  enabled: true,
  distanceAtr: 2.5,
};

/**
 * Position Manager Service
 * CRITICAL: Monitors all active positions every 10 seconds
 * Updates P&L, checks TP/SL, manages trailing stops
 */
@Injectable()
export class PositionManagerService {
  private cooldowns: Map<string, Date> = new Map();

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    private readonly cacheService: DataCacheService,
    private readonly riskManager: RiskManagerService,
    private readonly binanceService: BinanceService,
    private readonly logger: CustomLoggerService,
    private readonly wsGateway: TradingWebSocketGateway,
  ) {}

  /**
   * Monitor all active positions (runs every 10 seconds)
   */
  @Cron('*/10 * * * * *')
  async monitorAllPositions(): Promise<void> {
    try {
      // Only monitor DualStrategy positions (CYCLE_RIDER, HOUR_SWING, BOX_RANGE)
      const activePositions = await this.positionRepo.find({
        where: {
          status: PositionStatus.ACTIVE,
          strategy_type: In([StrategyType.CYCLE_RIDER, StrategyType.HOUR_SWING, StrategyType.BOX_RANGE]),
        },
      });

      if (activePositions.length === 0) {
        return;
      }

      this.logger.debug(
        `Monitoring ${activePositions.length} active positions`,
        'PositionManager',
      );

      for (const position of activePositions) {
        await this.monitorPosition(position);
      }
    } catch (error) {
      this.logger.error(
        `Error monitoring positions: ${error.message}`,
        error.stack,
        'PositionManager',
      );
    }
  }

  /**
   * Monitor a single position
   */
  private async monitorPosition(position: Position): Promise<void> {
    try {
      // Get current price
      const currentPrice = await this.cacheService.getCurrentPrice(position.symbol);
      if (!currentPrice) {
        this.logger.warn(`No price data for ${position.symbol}`, 'PositionManager');
        return;
      }

      // Calculate unrealized P&L
      const pnl = this.calculatePnL(
        position.direction,
        position.entry_price,
        currentPrice,
        position.remaining_size,
        position.leverage,
      );

      const pnlPercent = (pnl / position.margin_usd) * 100;

      // Update position in database
      await this.positionRepo.update(position.id, {
        current_price: currentPrice,
        unrealized_pnl: pnl,
        unrealized_pnl_percent: pnlPercent,
        last_update_time: new Date(),
        metadata: {
          ...position.metadata,
          max_pnl: Math.max(position.metadata?.max_pnl || pnl, pnl),
          min_pnl: Math.min(position.metadata?.min_pnl || pnl, pnl),
        } as any,
      });

      // Emit real-time update to frontend
      this.wsGateway.emitPositionUpdate({
        positionId: position.position_id,
        symbol: position.symbol,
        currentPrice,
        unrealizedPnl: pnl,
        unrealizedPnlPercent: pnlPercent,
      });

      // Check for exit conditions
      await this.checkExitConditions(position, currentPrice, pnl, pnlPercent);
    } catch (error) {
      this.logger.error(
        `Error monitoring position ${position.position_id}: ${error.message}`,
        error.stack,
        'PositionManager',
      );
    }
  }

  /**
   * Check exit conditions (trailing stop only)
   *
   * CRITICAL FIX: SL/TP checks REMOVED to prevent race conditions
   *
   * Bug was: PositionManager checked price vs SL/TP levels every 10 seconds.
   * When price touched SL/TP, PositionManager would:
   *   1. Cancel all Binance orders (including the real SL/TP orders!)
   *   2. Mark position as CLOSED in DB
   *   3. BUT NOT actually close the position on Binance!
   * Result: Position left open on Binance without any SL protection.
   *
   * Solution: Let Binance SL/TP orders execute naturally.
   * UserDataStream handles the actual fills and updates DB accordingly.
   * PositionManager only handles: trailing stops, P&L monitoring, time-based exits.
   */
  private async checkExitConditions(
    position: Position,
    currentPrice: number,
    pnl: number,
    pnlPercent: number,
  ): Promise<void> {
    const isLong = position.direction === 'LONG';

    // SL/TP checks REMOVED - handled by Binance orders + UserDataStream
    // DO NOT check SL/TP here - it causes race conditions that cancel orders
    // while leaving positions open on Binance without protection!

    // Only check trailing stop (which is managed separately from SL/TP orders)
    if (position.trailing_enabled && position.trailing_stop_price) {
      if (
        (isLong && currentPrice <= position.trailing_stop_price) ||
        (!isLong && currentPrice >= position.trailing_stop_price)
      ) {
        // CRITICAL: Actually close position on Binance before canceling orders
        this.logger.log(
          `🎯 Trailing stop hit for ${position.symbol}: Price ${currentPrice} vs Trailing ${position.trailing_stop_price}`,
          'PositionManager',
        );

        try {
          // First, close the actual position on Binance
          const side = isLong ? 'SELL' : 'BUY';
          await this.binanceService.futuresOrder({
            symbol: position.symbol,
            side,
            type: 'MARKET',
            quantity: position.remaining_size.toString(),
          });
          this.logger.log(
            `✅ Trailing stop executed: ${position.symbol} ${side} MARKET @ ${currentPrice}`,
            'PositionManager',
          );
        } catch (error) {
          this.logger.error(
            `❌ Failed to execute trailing stop for ${position.symbol}: ${error.message}`,
            error.stack,
            'PositionManager',
          );
          return; // Don't mark as closed if we couldn't close on Binance
        }

        await this.closePosition(position, currentPrice, CloseReason.TRAILING_STOP, pnl);
        return;
      }

      // Update trailing stop if price moved in our favor
      await this.updateTrailingStop(position, currentPrice);
    }

    // Time-based exits disabled per user request
  }

  /**
   * Close position completely
   */
  private async closePosition(
    position: Position,
    exitPrice: number,
    reason: CloseReason,
    finalPnl: number,
  ): Promise<void> {
    try {
      // CRITICAL: Cancel all remaining conditional orders (TP/SL) on Binance
      try {
        await this.binanceService.cancelAllOrders(position.symbol);
        this.logger.log(
          `Cancelled all conditional orders for ${position.symbol} (position fully closed)`,
          'PositionManager',
        );
      } catch (error) {
        this.logger.warn(
          `Failed to cancel conditional orders for ${position.symbol}: ${error.message}`,
          'PositionManager',
        );
      }

      // Update position status
      await this.positionRepo.update(position.id, {
        status: PositionStatus.CLOSED,
        current_price: exitPrice,
      });

      // Update trade
      const trade = await this.tradeRepo.findOne({
        where: { trade_id: position.trade_id },
      });

      if (trade) {
        const finalPnlPercent = (finalPnl / Number(trade.margin_usd)) * 100;

        await this.tradeRepo.update(trade.id, {
          status: TradeStatus.CLOSED,
          exit_price: exitPrice,
          exit_time: new Date(),
          pnl_usd: finalPnl,
          pnl_percent: finalPnlPercent,
          close_reason: reason,
        });

        // Record outcome with risk manager (with symbol for cooldown)
        this.riskManager.recordTradeOutcome(finalPnl, trade.symbol);

        // Log position closed
        await this.logger.logStrategy({
          level: 'info',
          strategyType: trade.strategy_type,
          subStrategy: trade.sub_strategy,
          symbol: trade.symbol,
          eventType: EventType.POSITION_CLOSED,
          message: `Position closed: ${reason}`,
          tradeId: trade.trade_id,
          positionId: position.position_id,
          metadata: {
            exitPrice,
            pnl: finalPnl,
            pnlPercent: finalPnlPercent,
            reason,
          },
        });

        // Emit to frontend
        this.wsGateway.emitTradeClosed({
          tradeId: trade.trade_id,
          status: 'CLOSED',
          exitPrice,
          pnl: finalPnl,
          pnlPercent: finalPnlPercent,
          closeReason: reason,
        });

        this.logger.log(
          `Position closed: ${position.symbol} ${position.direction} @ ${exitPrice} | P&L: $${finalPnl.toFixed(2)} (${finalPnlPercent.toFixed(2)}%)`,
          'PositionManager',
        );
      }
    } catch (error) {
      this.logger.error(
        `Error closing position ${position.position_id}: ${error.message}`,
        error.stack,
        'PositionManager',
      );
    }
  }

  /**
   * Close partial position (TP1 or TP2)
   */
  private async closePartialPosition(
    position: Position,
    exitPrice: number,
    level: 'TP1' | 'TP2',
    percent: number,
  ): Promise<void> {
    try {
      this.logger.log(
        `📊 ${level} Partial Close - ${position.symbol}: ` +
        `Position Size: ${position.position_size}, ` +
        `Remaining: ${position.remaining_size}, ` +
        `Closing: ${percent}%`,
        'PositionManager',
      );

      const closedSize = position.remaining_size * (percent / 100);
      const remainingSize = position.remaining_size - closedSize;

      this.logger.log(
        `💰 ${level} Calculation - ${position.symbol}: ` +
        `${position.remaining_size} × ${percent}% = ${closedSize} to close, ` +
        `${remainingSize} remaining`,
        'PositionManager',
      );

      const partialPnl = this.calculatePnL(
        position.direction,
        position.entry_price,
        exitPrice,
        closedSize,
        position.leverage,
      );

      // TP2는 마지막 50%이므로 전체 종료
      const isFinalClose = level === 'TP2';
      const finalPnl = Number(position.realized_pnl) + partialPnl;

      // Update position
      await this.positionRepo.update(position.id, {
        remaining_size: isFinalClose ? 0 : remainingSize,
        realized_pnl: finalPnl,
        [level === 'TP1' ? 'tp1_filled' : 'tp2_filled']: true,
        status: isFinalClose ? PositionStatus.CLOSED : position.status,
        current_price: exitPrice,
      });

      // Update trade
      const trade = await this.tradeRepo.findOne({
        where: { trade_id: position.trade_id },
      });

      if (trade) {
        await this.tradeRepo.update(trade.id, {
          [level === 'TP1' ? 'tp1_filled' : 'tp2_filled']: true,
          remaining_position_percent: isFinalClose ? 0 : 100 - percent,
          // TP2일 경우 Trade도 CLOSED로 업데이트
          ...(isFinalClose && {
            status: TradeStatus.CLOSED,
            exit_price: exitPrice,
            exit_time: new Date(),
            pnl_usd: finalPnl,
            pnl_percent: (finalPnl / Number(trade.margin_usd)) * 100,
            close_reason: CloseReason.TP2_HIT,
          }),
        });

        // Log event
        await this.logger.logStrategy({
          level: 'info',
          strategyType: trade.strategy_type,
          symbol: trade.symbol,
          eventType: level === 'TP1' ? EventType.TP1_HIT : EventType.TP2_HIT,
          message: `${level} hit: ${percent}% closed${isFinalClose ? ' - Position fully closed' : ''}`,
          tradeId: trade.trade_id,
          positionId: position.position_id,
          metadata: { exitPrice, partialPnl, percent, isFinalClose },
        });

        this.logger.log(
          `${level} hit for ${position.symbol}: ${percent}% closed @ ${exitPrice}${isFinalClose ? ' (FINAL)' : ''}`,
          'PositionManager',
        );

        // Box Range specific logic after TP1
        if (level === 'TP1' && trade.strategy_type === 'BOX_RANGE') {
          await this.handleBoxRangeTP1(position, trade, exitPrice);
        }

        // Box Range specific logic after TP2 (enable trailing stop)
        if (level === 'TP2' && trade.strategy_type === 'BOX_RANGE' && !isFinalClose) {
          // Note: TP2 in Box Range closes 30%, not final close
          // Enable trailing stop for remaining 30%
          await this.enableBoxRangeTrailingStop(position, trade, exitPrice);
        }

        // CRITICAL: TP2는 여기서 직접 종료, closePosition 호출 안함 (중복 방지)
        if (isFinalClose) {
          // Record outcome with risk manager (with symbol for cooldown)
          await this.riskManager.recordTradeOutcome(finalPnl, position.symbol);
        }
      }
    } catch (error) {
      this.logger.error(
        `Error closing partial position: ${error.message}`,
        error.stack,
        'PositionManager',
      );
    }
  }

  /**
   * Update trailing stop
   */
  private async updateTrailingStop(position: Position, currentPrice: number): Promise<void> {
    const isLong = position.direction === 'LONG';

    // Box Range specific trailing stop (0.5 ATR)
    if (position.strategy_type === 'BOX_RANGE' && position.metadata?.boxRangeTrailing) {
      const atr = position.metadata.atr || (currentPrice * 0.005);
      const trailingAtr = position.metadata.trailingAtr || 0.5;
      const atrDistance = atr * trailingAtr;

      let newTrailingStop: number;
      if (isLong) {
        newTrailingStop = currentPrice - atrDistance;
        // Only update if new stop is higher (more favorable)
        if (!position.trailing_stop_price || newTrailingStop > position.trailing_stop_price) {
          await this.positionRepo.update(position.id, {
            trailing_stop_price: newTrailingStop,
          });
        }
      } else {
        newTrailingStop = currentPrice + atrDistance;
        // Only update if new stop is lower (more favorable)
        if (!position.trailing_stop_price || newTrailingStop < position.trailing_stop_price) {
          await this.positionRepo.update(position.id, {
            trailing_stop_price: newTrailingStop,
          });
        }
      }
      return;
    }

    // Legacy strategy trailing stop (CYCLE_RIDER, HOUR_SWING)
    // Note: These strategies are deprecated - use CORE_TREND/SQUEEZE via UnifiedOrchestratorService
    const isLegacyStrategy = ['CYCLE_RIDER', 'HOUR_SWING'].includes(position.strategy_type);
    if (!isLegacyStrategy) return;

    const config = LEGACY_TRAILING_CONFIG;
    if (!config.enabled) return;

    // Calculate new trailing stop based on ATR
    // For simplicity, use 1% of price as ATR approximation
    const atrDistance = currentPrice * 0.01 * config.distanceAtr;

    let newTrailingStop: number;
    if (isLong) {
      newTrailingStop = currentPrice - atrDistance;
      // Only update if new stop is higher (more favorable)
      if (!position.trailing_stop_price || newTrailingStop > position.trailing_stop_price) {
        await this.positionRepo.update(position.id, {
          trailing_stop_price: newTrailingStop,
        });
      }
    } else {
      newTrailingStop = currentPrice + atrDistance;
      // Only update if new stop is lower (more favorable)
      if (!position.trailing_stop_price || newTrailingStop < position.trailing_stop_price) {
        await this.positionRepo.update(position.id, {
          trailing_stop_price: newTrailingStop,
        });
      }
    }
  }

  /**
   * Check time-based exits
   * DISABLED: Time-based forced closures removed per user request
   */
  private async checkTimeBasedExits(
    position: Position,
    currentPrice: number,
    pnl: number,
  ): Promise<void> {
    // CRITICAL: COMPLETELY DISABLED
    // User strategy: Hold positions long-term, no time-based forced closures
    // Only TP/SL should close positions
    return;

    // Time-based exits completely disabled - legacy strategies removed
    // Use UnifiedOrchestratorService for CORE_TREND/SQUEEZE with proper time stops
  }

  /**
   * Calculate P&L (수수료 포함)
   * 바이낸스 선물 수수료: 테이커 0.04% (진입 + 청산 = 0.08%)
   */
  private calculatePnL(
    direction: string,
    entryPrice: number,
    currentPrice: number,
    size: number,
    leverage: number,
    includeCommission: boolean = true,
  ): number {
    const priceChange = direction === 'LONG'
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;

    const pnlPercent = (priceChange / entryPrice) * leverage;
    const notional = size * entryPrice;
    const margin = notional / leverage;

    let pnl = margin * pnlPercent;

    // 수수료 차감 (진입 0.04% + 청산 0.04% = 0.08%)
    if (includeCommission) {
      const commissionRate = 0.0008; // 0.08%
      const commission = notional * commissionRate;
      pnl -= commission;
    }

    return pnl;
  }

  /**
   * Check if symbol is in cooldown
   */
  async isInCooldown(symbol: string, strategyType: string, cooldownMinutes: number): Promise<boolean> {
    const key = `${symbol}_${strategyType}`;
    const lastClose = this.cooldowns.get(key);

    if (!lastClose) return false;

    const minutesSince = (Date.now() - lastClose.getTime()) / 1000 / 60;
    return minutesSince < cooldownMinutes;
  }

  /**
   * Set cooldown for symbol
   */
  setCooldown(symbol: string, strategyType: string): void {
    const key = `${symbol}_${strategyType}`;
    this.cooldowns.set(key, new Date());
  }

  /**
   * Handle Box Range TP1 - Move SL to breakeven + 0.1%
   * @deprecated Legacy Box Range strategy removed - kept for backwards compatibility
   */
  private async handleBoxRangeTP1(position: Position, trade: Trade, tp1Price: number): Promise<void> {
    try {
      // Legacy config - Box Range strategy deprecated
      const breakevenBuffer = 0.001; // 0.1%

      const isLong = position.direction === 'LONG';
      const newSL = isLong
        ? position.entry_price * (1 + breakevenBuffer)
        : position.entry_price * (1 - breakevenBuffer);

      await this.positionRepo.update(position.id, {
        sl_price: newSL,
      });

      this.logger.log(
        `[Box Range] ${position.symbol} TP1 hit - SL moved to breakeven + ${(breakevenBuffer * 100).toFixed(1)}%: ${newSL.toFixed(8)}`,
        'PositionManager',
      );

      await this.logger.logStrategy({
        level: 'info',
        strategyType: trade.strategy_type,
        symbol: trade.symbol,
        eventType: EventType.SL_ADJUSTED,
        message: `Box Range: SL moved to breakeven after TP1`,
        tradeId: trade.trade_id,
        positionId: position.position_id,
        metadata: {
          oldSL: position.sl_price,
          newSL,
          trigger: 'TP1_HIT',
        },
      });
    } catch (error) {
      this.logger.error(
        `Error handling Box Range TP1 for ${position.position_id}: ${error.message}`,
        error.stack,
        'PositionManager',
      );
    }
  }

  /**
   * Enable Box Range trailing stop (0.5 ATR) after TP2
   * @deprecated Legacy Box Range strategy removed - kept for backwards compatibility
   */
  private async enableBoxRangeTrailingStop(position: Position, trade: Trade, tp2Price: number): Promise<void> {
    try {
      // Legacy config - Box Range strategy deprecated
      const trailingAtr = 0.5;

      // Get ATR from trade metadata
      const atr = trade.metadata?.atr || (position.entry_price * 0.005); // Fallback to 0.5% if no ATR

      const isLong = position.direction === 'LONG';
      const currentPrice = position.current_price || position.entry_price;

      // Calculate initial trailing stop
      const trailingStop = isLong
        ? currentPrice - (atr * trailingAtr)
        : currentPrice + (atr * trailingAtr);

      await this.positionRepo.update(position.id, {
        trailing_enabled: true,
        trailing_stop_price: trailingStop,
        metadata: {
          ...position.metadata,
          boxRangeTrailing: true,
          trailingAtr,
          atr,
        } as any,
      });

      this.logger.log(
        `[Box Range] ${position.symbol} TP2 hit - Trailing stop enabled: ${trailingAtr} ATR = ${trailingStop.toFixed(8)}`,
        'PositionManager',
      );

      await this.logger.logStrategy({
        level: 'info',
        strategyType: trade.strategy_type,
        symbol: trade.symbol,
        eventType: EventType.TRAILING_ACTIVATED,
        message: `Box Range: 0.5 ATR trailing stop enabled after TP2`,
        tradeId: trade.trade_id,
        positionId: position.position_id,
        metadata: {
          trailingStop,
          trailingAtr,
          atr,
        },
      });
    } catch (error) {
      this.logger.error(
        `Error enabling Box Range trailing stop for ${position.position_id}: ${error.message}`,
        error.stack,
        'PositionManager',
      );
    }
  }

  /**
   * Get active positions
   */
  async getActivePositions(): Promise<Position[]> {
    return await this.positionRepo.find({
      where: { status: PositionStatus.ACTIVE },
    });
  }
}
