import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum StrategyType {
  CYCLE_RIDER = 'CYCLE_RIDER',
  HOUR_SWING = 'HOUR_SWING',
  BOX_RANGE = 'BOX_RANGE',
}

export enum TradeDirection {
  LONG = 'LONG',
  SHORT = 'SHORT',
}

export enum TradeStatus {
  PENDING = 'PENDING',
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  CANCELLED = 'CANCELLED',
}

export enum CloseReason {
  TP1 = 'TP1', // Alias for TP1_HIT
  TP2 = 'TP2', // Alias for TP2
  STOP_LOSS = 'STOP_LOSS', // Alias for SL_HIT
  TP1_HIT = 'TP1_HIT',
  TP2_HIT = 'TP2_HIT',
  SL_HIT = 'SL_HIT',
  TRAILING_STOP = 'TRAILING_STOP',
  TIME_BASED = 'TIME_BASED',
  MANUAL = 'MANUAL',
  RISK_LIMIT = 'RISK_LIMIT',
  EMERGENCY_CLOSE = 'EMERGENCY_CLOSE',
  FORCED_CLOSE_OR_LIQUIDATION = 'FORCED_CLOSE_OR_LIQUIDATION',
}

@Entity('trades')
@Index(['symbol', 'strategy_type', 'entry_time'])
@Index(['status', 'entry_time'])
export class Trade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  trade_id: string;

  // Strategy information - CRITICAL for tracking which strategy made the trade
  @Column({
    type: 'enum',
    enum: StrategyType,
  })
  @Index()
  strategy_type: StrategyType;

  @Column({ nullable: true })
  sub_strategy: string; // accumulation, distribution, divergence, etc.

  // Symbol and direction
  @Column()
  @Index()
  symbol: string;

  @Column({
    type: 'enum',
    enum: TradeDirection,
  })
  direction: TradeDirection;

  // Prices
  @Column('decimal', { precision: 20, scale: 8 })
  entry_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  exit_price: number;

  @Column('decimal', { precision: 20, scale: 8 })
  sl_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp1_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp2_price: number;

  // Position details
  @Column('int')
  leverage: number;

  @Column('decimal', { precision: 20, scale: 8 })
  margin_usd: number;

  @Column('decimal', { precision: 20, scale: 8 })
  position_size: number; // in base currency

  // Times
  @Column({ type: 'timestamptz' })
  @Index()
  entry_time: Date;

  @Column({ type: 'timestamptz', nullable: true })
  exit_time: Date;

  // P&L
  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  pnl_usd: number;

  @Column('decimal', { precision: 10, scale: 4, default: 0 })
  pnl_percent: number; // percentage return

  // Status
  @Column({
    type: 'enum',
    enum: TradeStatus,
    default: TradeStatus.PENDING,
  })
  @Index()
  status: TradeStatus;

  @Column({
    type: 'enum',
    enum: CloseReason,
    nullable: true,
  })
  close_reason: CloseReason;

  // Signal metadata
  @Column('int', { nullable: true })
  signal_confidence: number; // 0-100

  @Column({ nullable: true })
  market_regime: string; // STRONG_UPTREND, WEAK_UPTREND, etc.

  // Partial close tracking
  @Column('boolean', { default: false })
  tp1_filled: boolean;

  @Column('boolean', { default: false })
  tp2_filled: boolean;

  @Column('decimal', { precision: 10, scale: 4, default: 100 })
  remaining_position_percent: number;

  // Additional metadata (stored as JSON)
  @Column('jsonb', { nullable: true })
  metadata: {
    atr?: number;
    funding_rate?: number;
    volume_rank?: number;
    consecutive_bars?: number;
    trend_strength?: number;
    [key: string]: any;
  };

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
