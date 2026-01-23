import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { StrategyType, TradeDirection } from './trade.entity';

export enum PositionStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  LIQUIDATED = 'LIQUIDATED',
}

@Entity('positions')
@Index(['symbol', 'status'])
@Index(['strategy_type', 'status'])
export class Position {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  position_id: string;

  @Column({ nullable: true })
  @Index()
  trade_id: string; // Reference to trade

  // Strategy information
  @Column({
    type: 'enum',
    enum: StrategyType,
  })
  strategy_type: StrategyType;

  @Column({ nullable: true })
  sub_strategy: string;

  // Position details
  @Column()
  @Index()
  symbol: string;

  @Column({
    type: 'enum',
    enum: TradeDirection,
  })
  direction: TradeDirection;

  @Column({
    type: 'enum',
    enum: PositionStatus,
    default: PositionStatus.ACTIVE,
  })
  @Index()
  status: PositionStatus;

  // Prices
  @Column('decimal', { precision: 20, scale: 8 })
  entry_price: number;

  @Column('decimal', { precision: 20, scale: 8 })
  current_price: number;

  @Column('decimal', { precision: 20, scale: 8 })
  sl_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp1_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp2_price: number;

  // Position sizing
  @Column('int')
  leverage: number;

  @Column('decimal', { precision: 20, scale: 8 })
  margin_usd: number;

  @Column('decimal', { precision: 20, scale: 8 })
  position_size: number;

  @Column('decimal', { precision: 20, scale: 8 })
  remaining_size: number;

  // Real-time P&L
  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  unrealized_pnl: number;

  @Column('decimal', { precision: 10, scale: 4, default: 0 })
  unrealized_pnl_percent: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  realized_pnl: number;

  // Partial close tracking
  @Column('boolean', { default: false })
  tp1_filled: boolean;

  @Column('boolean', { default: false })
  tp2_filled: boolean;

  // SL/TP Order IDs (for tracking fills)
  @Column({ nullable: true })
  sl_order_id: string;

  @Column({ nullable: true })
  tp1_order_id: string;

  @Column({ nullable: true })
  tp2_order_id: string;

  // Trailing stop
  @Column('boolean', { default: false })
  trailing_enabled: boolean;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  trailing_stop_price: number;

  // Timing
  @Column({ type: 'timestamptz' })
  entry_time: Date;

  @Column({ type: 'timestamptz', nullable: true })
  last_update_time: Date;

  // Metadata
  @Column('jsonb', { nullable: true })
  metadata: {
    max_pnl?: number;
    max_pnl_percent?: number;
    min_pnl?: number;
    min_pnl_percent?: number;
    [key: string]: any;
  };

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
