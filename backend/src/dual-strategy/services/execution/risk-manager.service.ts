import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Trade, TradeStatus } from '../../../entities/trade.entity';
import { Position, PositionStatus } from '../../../entities/position.entity';
import { RiskEvent, RiskEventType, RiskSeverity } from '../../../entities/risk-event.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { DataCacheService } from '../data/data-cache.service';

const RISK_CONFIG = {
  dailyLossLimit: {
    enabled: true,
    maxLossPercent: 5,
    maxLossUsd: 100,
  },
  consecutiveLoss: {
    enabled: true,
    maxCount: 3,
    cooldownMinutes: 30,
  },
  drawdown: {
    enabled: true,
    maxDrawdownPercent: 10,
    reducePositionAtPercent: 7,
  },
  position: {
    maxTotalPositions: 8,
    maxSameSymbol: 1,
    maxSameDirection: 5,
    maxExposurePercent: 80,
  },
  volatility: {
    enabled: true,
    maxBtcMovePercent: 5,
  },
};

/**
 * Risk Manager Service
 * Enforces all risk limits and prevents dangerous trades
 * CRITICAL: Uses Redis for persistence (survives restarts)
 */
@Injectable()
export class RiskManagerService {
  private readonly REDIS_KEY_CONSECUTIVE_LOSS = 'risk:consecutive_loss_count';
  private readonly REDIS_KEY_LAST_LOSS_TIME = 'risk:last_loss_time';
  private readonly REDIS_KEY_SYMBOL_COOLDOWN = 'risk:symbol_cooldown:'; // + symbol
  private readonly SYMBOL_COOLDOWN_HOURS = 1; // 1 hour cooldown after loss

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(RiskEvent)
    private readonly riskEventRepo: Repository<RiskEvent>,
    private readonly logger: CustomLoggerService,
    private readonly cacheService: DataCacheService,
  ) {}

  /**
   * Get consecutive loss count from Redis
   * CRITICAL: Persists across restarts
   */
  private async getConsecutiveLossCount(): Promise<number> {
    try {
      const count = await this.cacheService.client.get(this.REDIS_KEY_CONSECUTIVE_LOSS);
      return count ? parseInt(count, 10) : 0;
    } catch (error) {
      this.logger.error(`Failed to get consecutive loss count from Redis: ${error.message}`, '', 'RiskManager');
      return 0;
    }
  }

  /**
   * Get last loss time from Redis
   */
  private async getLastLossTime(): Promise<Date | null> {
    try {
      const timestamp = await this.cacheService.client.get(this.REDIS_KEY_LAST_LOSS_TIME);
      return timestamp ? new Date(parseInt(timestamp, 10)) : null;
    } catch (error) {
      this.logger.error(`Failed to get last loss time from Redis: ${error.message}`, '', 'RiskManager');
      return null;
    }
  }

  /**
   * Set consecutive loss count in Redis
   */
  private async setConsecutiveLossCount(count: number): Promise<void> {
    try {
      if (count === 0) {
        await this.cacheService.client.del(this.REDIS_KEY_CONSECUTIVE_LOSS);
        await this.cacheService.client.del(this.REDIS_KEY_LAST_LOSS_TIME);
      } else {
        await this.cacheService.client.set(this.REDIS_KEY_CONSECUTIVE_LOSS, count.toString());
        await this.cacheService.client.set(this.REDIS_KEY_LAST_LOSS_TIME, Date.now().toString());
        // Set 24-hour expiry (reset daily)
        await this.cacheService.client.expire(this.REDIS_KEY_CONSECUTIVE_LOSS, 86400);
        await this.cacheService.client.expire(this.REDIS_KEY_LAST_LOSS_TIME, 86400);
      }
    } catch (error) {
      this.logger.error(`Failed to set consecutive loss count in Redis: ${error.message}`, '', 'RiskManager');
    }
  }

  /**
   * Check if we can open a new position
   */
  async canOpenNewPosition(symbol?: string, direction?: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    // 1. Check daily loss limit
    if (RISK_CONFIG.dailyLossLimit.enabled) {
      const dailyLoss = await this.checkDailyLossLimit();
      if (!dailyLoss.allowed) {
        await this.recordRiskEvent(
          RiskEventType.DAILY_LOSS_LIMIT,
          RiskSeverity.CRITICAL,
          dailyLoss.reason,
          null,
          dailyLoss.currentValue,
          dailyLoss.limitValue,
        );
        return dailyLoss;
      }
    }

    // 2. Check consecutive loss
    if (RISK_CONFIG.consecutiveLoss.enabled) {
      const consecutiveLoss = await this.checkConsecutiveLoss();
      if (!consecutiveLoss.allowed) {
        const consecutiveLossCount = await this.getConsecutiveLossCount();
        await this.recordRiskEvent(
          RiskEventType.CONSECUTIVE_LOSS,
          RiskSeverity.HIGH,
          consecutiveLoss.reason,
          null,
          consecutiveLossCount,
          RISK_CONFIG.consecutiveLoss.maxCount,
        );
        return consecutiveLoss;
      }
    }

    // 3. Check total positions
    const maxPositions = await this.checkMaxPositions();
    if (!maxPositions.allowed) {
      await this.recordRiskEvent(
        RiskEventType.MAX_POSITIONS,
        RiskSeverity.MEDIUM,
        maxPositions.reason,
        symbol,
        maxPositions.currentValue,
        maxPositions.limitValue,
      );
      return maxPositions;
    }

    // 4. Check symbol cooldown (after loss)
    if (symbol) {
      const symbolCooldown = await this.checkSymbolCooldown(symbol);
      if (!symbolCooldown.allowed) {
        this.logger.warn(`Symbol ${symbol} is on cooldown: ${symbolCooldown.reason}`);
        await this.recordRiskEvent(
          RiskEventType.COOLDOWN_ACTIVE,
          RiskSeverity.MEDIUM,
          symbolCooldown.reason,
          symbol,
        );
        return symbolCooldown;
      }
    }

    // 5. Check same symbol
    if (symbol) {
      const sameSymbol = await this.checkSameSymbol(symbol);
      if (!sameSymbol.allowed) {
        await this.recordRiskEvent(
          RiskEventType.MAX_POSITIONS,
          RiskSeverity.MEDIUM,
          sameSymbol.reason,
          symbol,
        );
        return sameSymbol;
      }
    }

    // 6. Check same direction
    if (direction) {
      const sameDirection = await this.checkSameDirection(direction);
      if (!sameDirection.allowed) {
        await this.recordRiskEvent(
          RiskEventType.MAX_POSITIONS,
          RiskSeverity.MEDIUM,
          sameDirection.reason,
          symbol,
          sameDirection.currentValue,
          sameDirection.limitValue,
        );
        return sameDirection;
      }
    }

    return { allowed: true };
  }

  /**
   * Check daily loss limit
   */
  private async checkDailyLossLimit(): Promise<{
    allowed: boolean;
    reason?: string;
    currentValue?: number;
    limitValue?: number;
  }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 1. Get realized P&L from closed trades today
    const todayTrades = await this.tradeRepo.find({
      where: {
        status: TradeStatus.CLOSED,
        exit_time: Between(today, tomorrow),
      },
    });

    const realizedPnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl_usd), 0);

    // 2. Get unrealized P&L from open positions (CRITICAL: Equity-based risk management)
    const openPositions = await this.positionRepo.find({
      where: { status: PositionStatus.ACTIVE },
    });

    const unrealizedPnl = openPositions.reduce((sum, p) => sum + Number(p.unrealized_pnl || 0), 0);

    // 3. Total P&L (Equity-based) = Realized + Unrealized
    const totalPnl = realizedPnl + unrealizedPnl;

    this.logger.debug(
      `Daily P&L check: Realized=${realizedPnl.toFixed(2)}, Unrealized=${unrealizedPnl.toFixed(2)}, Total=${totalPnl.toFixed(2)}`,
    );

    if (totalPnl < -RISK_CONFIG.dailyLossLimit.maxLossUsd) {
      return {
        allowed: false,
        reason: `Daily loss limit reached (Equity-based): $${Math.abs(totalPnl).toFixed(2)} / $${RISK_CONFIG.dailyLossLimit.maxLossUsd} (Realized: $${realizedPnl.toFixed(2)}, Unrealized: $${unrealizedPnl.toFixed(2)})`,
        currentValue: Math.abs(totalPnl),
        limitValue: RISK_CONFIG.dailyLossLimit.maxLossUsd,
      };
    }

    return { allowed: true };
  }

  /**
   * Check consecutive loss
   */
  private async checkConsecutiveLoss(): Promise<{ allowed: boolean; reason?: string }> {
    const consecutiveLossCount = await this.getConsecutiveLossCount();

    if (consecutiveLossCount >= RISK_CONFIG.consecutiveLoss.maxCount) {
      // Check cooldown
      const lastLossTime = await this.getLastLossTime();
      if (lastLossTime) {
        const minutesSinceLoss = (Date.now() - lastLossTime.getTime()) / 1000 / 60;
        if (minutesSinceLoss < RISK_CONFIG.consecutiveLoss.cooldownMinutes) {
          return {
            allowed: false,
            reason: `Consecutive loss cooldown: ${RISK_CONFIG.consecutiveLoss.cooldownMinutes - Math.floor(minutesSinceLoss)} minutes remaining`,
          };
        } else {
          // Cooldown expired, reset
          await this.setConsecutiveLossCount(0);
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Check max total positions
   */
  private async checkMaxPositions(): Promise<{
    allowed: boolean;
    reason?: string;
    currentValue?: number;
    limitValue?: number;
  }> {
    const activePositions = await this.positionRepo.count({
      where: { status: PositionStatus.ACTIVE },
    });

    if (activePositions >= RISK_CONFIG.position.maxTotalPositions) {
      return {
        allowed: false,
        reason: `Max total positions reached: ${activePositions} / ${RISK_CONFIG.position.maxTotalPositions}`,
        currentValue: activePositions,
        limitValue: RISK_CONFIG.position.maxTotalPositions,
      };
    }

    return { allowed: true };
  }

  /**
   * Check same symbol
   */
  private async checkSameSymbol(symbol: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    const sameSymbolCount = await this.positionRepo.count({
      where: { symbol, status: PositionStatus.ACTIVE },
    });

    if (sameSymbolCount >= RISK_CONFIG.position.maxSameSymbol) {
      return {
        allowed: false,
        reason: `Already have position in ${symbol}`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check same direction
   */
  private async checkSameDirection(direction: string): Promise<{
    allowed: boolean;
    reason?: string;
    currentValue?: number;
    limitValue?: number;
  }> {
    const sameDirectionCount = await this.positionRepo.count({
      where: { direction: direction as any, status: PositionStatus.ACTIVE },
    });

    if (sameDirectionCount >= RISK_CONFIG.position.maxSameDirection) {
      return {
        allowed: false,
        reason: `Max same direction positions reached: ${sameDirectionCount} / ${RISK_CONFIG.position.maxSameDirection}`,
        currentValue: sameDirectionCount,
        limitValue: RISK_CONFIG.position.maxSameDirection,
      };
    }

    return { allowed: true };
  }

  /**
   * CRITICAL: Check if symbol is on cooldown after a loss
   */
  private async checkSymbolCooldown(symbol: string): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    try {
      const cooldownKey = this.REDIS_KEY_SYMBOL_COOLDOWN + symbol;
      const cooldownUntil = await this.cacheService.client.get(cooldownKey);

      if (cooldownUntil) {
        const cooldownTime = parseInt(cooldownUntil, 10);
        const now = Date.now();

        if (now < cooldownTime) {
          const remainingMinutes = Math.ceil((cooldownTime - now) / 60000);
          return {
            allowed: false,
            reason: `${symbol} is on cooldown after previous loss. Retry in ${remainingMinutes} minutes.`,
          };
        }
      }

      return { allowed: true };
    } catch (error) {
      this.logger.error(`Failed to check symbol cooldown: ${error.message}`, error.stack, 'RiskManager');
      return { allowed: true }; // Fail open to not block trading
    }
  }

  /**
   * Set symbol cooldown after a loss
   */
  private async setSymbolCooldown(symbol: string): Promise<void> {
    try {
      const cooldownKey = this.REDIS_KEY_SYMBOL_COOLDOWN + symbol;
      const cooldownUntil = Date.now() + (this.SYMBOL_COOLDOWN_HOURS * 60 * 60 * 1000);

      await this.cacheService.client.set(cooldownKey, cooldownUntil.toString());
      await this.cacheService.client.expire(cooldownKey, this.SYMBOL_COOLDOWN_HOURS * 60 * 60);

      this.logger.log(
        `🚫 Symbol ${symbol} placed on ${this.SYMBOL_COOLDOWN_HOURS}h cooldown after loss`,
        'RiskManager',
      );
    } catch (error) {
      this.logger.error(`Failed to set symbol cooldown: ${error.message}`, error.stack, 'RiskManager');
    }
  }

  /**
   * Record a trade outcome
   * CRITICAL: Sets symbol cooldown if trade was a loss
   */
  async recordTradeOutcome(pnl: number, symbol?: string): Promise<void> {
    if (pnl < 0) {
      // Increment consecutive loss counter
      const count = await this.getConsecutiveLossCount();
      await this.setConsecutiveLossCount(count + 1);

      // CRITICAL: Set symbol cooldown
      if (symbol) {
        await this.setSymbolCooldown(symbol);
      }
    } else {
      // Reset consecutive loss counter on win
      await this.setConsecutiveLossCount(0);
    }
  }

  /**
   * Record risk event
   */
  private async recordRiskEvent(
    eventType: RiskEventType,
    severity: RiskSeverity,
    description: string,
    symbol: string | null,
    currentValue?: number,
    limitValue?: number,
  ): Promise<void> {
    try {
      await this.riskEventRepo.save({
        event_type: eventType,
        severity,
        description,
        symbol,
        current_value: currentValue,
        limit_value: limitValue,
        action_taken: true,
        action_description: 'Position opening prevented',
      });

      this.logger.warn(`Risk event: ${description}`, 'RiskManager');
    } catch (error) {
      this.logger.error(`Failed to record risk event: ${error.message}`, error.stack, 'RiskManager');
    }
  }
}
