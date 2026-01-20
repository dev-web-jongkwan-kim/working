import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { StrategyType } from './trade.entity';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

export enum EventType {
  SIGNAL_GENERATED = 'SIGNAL_GENERATED',
  SIGNAL_REJECTED = 'SIGNAL_REJECTED',
  ORDER_PLACED = 'ORDER_PLACED',
  ORDER_FILLED = 'ORDER_FILLED',
  ORDER_FAILED = 'ORDER_FAILED',
  POSITION_OPENED = 'POSITION_OPENED',
  POSITION_UPDATED = 'POSITION_UPDATED',
  POSITION_CLOSED = 'POSITION_CLOSED',
  TP1_HIT = 'TP1_HIT',
  TP2_HIT = 'TP2_HIT',
  SL_HIT = 'SL_HIT',
  SL_ADJUSTED = 'SL_ADJUSTED',
  TRAILING_ACTIVATED = 'TRAILING_ACTIVATED',
  TRAILING_UPDATED = 'TRAILING_UPDATED',
  RISK_CHECK_FAILED = 'RISK_CHECK_FAILED',
  COOLDOWN_ACTIVE = 'COOLDOWN_ACTIVE',
  SYSTEM_START = 'SYSTEM_START',
  RISK_EVENT = 'RISK_EVENT',
  DATA_COLLECTION_START = 'DATA_COLLECTION_START',
  REDIS_CONNECT = 'REDIS_CONNECT',
}

@Entity('strategy_logs')
@Index(['strategy_type', 'created_at'])
@Index(['log_level', 'created_at'])
@Index(['event_type', 'created_at'])
export class StrategyLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Strategy information
  @Column({
    type: 'enum',
    enum: StrategyType,
    nullable: true,
  })
  @Index()
  strategy_type: StrategyType;

  @Column({ nullable: true })
  sub_strategy: string;

  @Column({ nullable: true })
  @Index()
  symbol: string;

  // Log details
  @Column({
    type: 'enum',
    enum: LogLevel,
  })
  @Index()
  log_level: LogLevel;

  @Column({
    type: 'enum',
    enum: EventType,
  })
  @Index()
  event_type: EventType;

  @Column('text')
  message: string;

  // References
  @Column({ nullable: true })
  trade_id: string;

  @Column({ nullable: true })
  position_id: string;

  @Column({ nullable: true })
  signal_id: string;

  // Additional data
  @Column('jsonb', { nullable: true })
  metadata: {
    [key: string]: any;
  };

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
