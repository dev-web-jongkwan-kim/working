import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { winstonLogger } from './logger.config';
import { StrategyLog, LogLevel as StrategyLogLevel, EventType } from '../../entities/strategy-log.entity';
import { SystemLog, LogLevel as SystemLogLevel, SystemEventType } from '../../entities/system-log.entity';
import { StrategyType } from '../../entities/trade.entity';

interface BaseLogData {
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  context?: string;
  metadata?: Record<string, any>;
}

interface StrategyLogData extends BaseLogData {
  strategyType: StrategyType;
  subStrategy?: string;
  symbol?: string;
  eventType: EventType;
  tradeId?: string;
  positionId?: string;
  signalId?: string;
}

interface SystemLogData extends BaseLogData {
  eventType: SystemEventType;
  component?: string;
}

/**
 * Custom Logger Service implementing 3-tier logging:
 * 1. Console - Real-time development monitoring
 * 2. File - Daily rotating JSON log files
 * 3. Database - Important logs only (queryable)
 */
@Injectable()
export class CustomLoggerService implements NestLoggerService {
  constructor(
    @InjectRepository(StrategyLog)
    private readonly strategyLogRepo: Repository<StrategyLog>,
    @InjectRepository(SystemLog)
    private readonly systemLogRepo: Repository<SystemLog>,
  ) {}

  /**
   * Tier 1 & 2: Log to console and file
   */
  private logToWinston(level: string, message: string, context?: string, metadata?: any) {
    winstonLogger.log({
      level,
      message,
      context,
      ...metadata,
    });
  }

  /**
   * Tier 3: Log strategy events to database (for important events only)
   */
  async logStrategy(data: StrategyLogData): Promise<void> {
    const { level, strategyType, subStrategy, symbol, eventType, message, tradeId, positionId, signalId, metadata, context } = data;

    // Tier 1 & 2: Console and File
    this.logToWinston(level, message, context || 'Strategy', {
      strategyType,
      subStrategy,
      symbol,
      eventType,
      tradeId,
      positionId,
      signalId,
      ...metadata,
    });

    // Tier 3: Database (only for important events)
    const importantEvents = [
      EventType.SIGNAL_GENERATED,
      EventType.ORDER_PLACED,
      EventType.ORDER_FILLED,
      EventType.POSITION_OPENED,
      EventType.POSITION_CLOSED,
      EventType.TP1_HIT,
      EventType.TP2_HIT,
      EventType.SL_HIT,
      EventType.RISK_CHECK_FAILED,
    ];

    if (importantEvents.includes(eventType) || level === 'error') {
      try {
        await this.strategyLogRepo.save({
          strategy_type: strategyType,
          sub_strategy: subStrategy,
          symbol,
          log_level: level.toUpperCase() as StrategyLogLevel,
          event_type: eventType,
          message,
          trade_id: tradeId,
          position_id: positionId,
          signal_id: signalId,
          metadata,
        });
      } catch (error) {
        // Fail silently to avoid recursion
        winstonLogger.error('Failed to save strategy log to database', { error: error.message });
      }
    }
  }

  /**
   * Tier 3: Log system events to database
   */
  async logSystem(data: SystemLogData): Promise<void> {
    const { level, eventType, message, component, metadata, context } = data;

    // Tier 1 & 2: Console and File
    this.logToWinston(level, message, context || 'System', {
      eventType,
      component,
      ...metadata,
    });

    // Tier 3: Database (only for important system events)
    const importantSystemEvents = [
      SystemEventType.SYSTEM_START,
      SystemEventType.SYSTEM_STOP,
      SystemEventType.DATABASE_ERROR,
      SystemEventType.WEBSOCKET_ERROR,
      SystemEventType.REDIS_ERROR,
      SystemEventType.MARKET_REGIME_UPDATE,
    ];

    if (importantSystemEvents.includes(eventType) || level === 'error') {
      try {
        await this.systemLogRepo.save({
          log_level: level.toUpperCase() as SystemLogLevel,
          event_type: eventType,
          message,
          component,
          metadata,
        });
      } catch (error) {
        winstonLogger.error('Failed to save system log to database', { error: error.message });
      }
    }
  }

  /**
   * NestJS LoggerService interface implementations
   * These log to console and file only (Tier 1 & 2)
   */
  log(message: string, context?: string) {
    this.logToWinston('info', message, context);
  }

  error(message: string, trace?: string, context?: string) {
    this.logToWinston('error', message, context, { trace });
  }

  warn(message: string, context?: string) {
    this.logToWinston('warn', message, context);
  }

  debug(message: string, context?: string) {
    this.logToWinston('debug', message, context);
  }

  verbose(message: string, context?: string) {
    this.logToWinston('debug', message, context);
  }

  /**
   * Convenience methods for common logging scenarios
   */
  async logSignalGenerated(
    strategyType: StrategyType,
    subStrategy: string,
    symbol: string,
    signalId: string,
    metadata?: Record<string, any>,
  ) {
    await this.logStrategy({
      level: 'info',
      strategyType,
      subStrategy,
      symbol,
      eventType: EventType.SIGNAL_GENERATED,
      message: `Signal generated: ${subStrategy} for ${symbol}`,
      signalId,
      metadata,
    });
  }

  async logOrderPlaced(
    strategyType: StrategyType,
    symbol: string,
    tradeId: string,
    metadata?: Record<string, any>,
  ) {
    await this.logStrategy({
      level: 'info',
      strategyType,
      symbol,
      eventType: EventType.ORDER_PLACED,
      message: `Order placed for ${symbol}`,
      tradeId,
      metadata,
    });
  }

  async logPositionOpened(
    strategyType: StrategyType,
    symbol: string,
    tradeId: string,
    positionId: string,
    metadata?: Record<string, any>,
  ) {
    await this.logStrategy({
      level: 'info',
      strategyType,
      symbol,
      eventType: EventType.POSITION_OPENED,
      message: `Position opened for ${symbol}`,
      tradeId,
      positionId,
      metadata,
    });
  }

  async logPositionClosed(
    strategyType: StrategyType,
    symbol: string,
    tradeId: string,
    positionId: string,
    reason: string,
    metadata?: Record<string, any>,
  ) {
    await this.logStrategy({
      level: 'info',
      strategyType,
      symbol,
      eventType: EventType.POSITION_CLOSED,
      message: `Position closed for ${symbol}: ${reason}`,
      tradeId,
      positionId,
      metadata,
    });
  }

  async logRiskCheckFailed(
    strategyType: StrategyType,
    symbol: string,
    reason: string,
    metadata?: Record<string, any>,
  ) {
    await this.logStrategy({
      level: 'warn',
      strategyType,
      symbol,
      eventType: EventType.RISK_CHECK_FAILED,
      message: `Risk check failed for ${symbol}: ${reason}`,
      metadata,
    });
  }
}
