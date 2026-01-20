import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { StrategyType, TradeDirection } from './trade.entity';

@Entity('signals')
@Index(['strategy_type', 'symbol', 'created_at'])
@Index(['executed', 'created_at'])
export class Signal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  signal_id: string;

  // Strategy information
  @Column({
    type: 'enum',
    enum: StrategyType,
  })
  @Index()
  strategy_type: StrategyType;

  @Column({ nullable: true })
  sub_strategy: string; // Specific sub-strategy that generated this signal

  // Signal details
  @Column()
  @Index()
  symbol: string;

  @Column({
    type: 'enum',
    enum: TradeDirection,
  })
  direction: TradeDirection;

  @Column('int')
  confidence: number; // 0-100

  // Price levels
  @Column('decimal', { precision: 20, scale: 8 })
  entry_price: number;

  @Column('decimal', { precision: 20, scale: 8 })
  sl_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp1_price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp2_price: number;

  // Execution status
  @Column('boolean', { default: false })
  @Index()
  executed: boolean;

  @Column('boolean', { default: false })
  rejected: boolean;

  @Column({ nullable: true })
  rejection_reason: string;

  @Column({ nullable: true })
  trade_id: string; // If executed, reference to the trade

  // Market context
  @Column({ nullable: true })
  market_regime: string;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  risk_reward_ratio: number;

  // Signal metadata
  @Column('jsonb', { nullable: true })
  metadata: {
    atr?: number;
    rsi?: number;
    cvd_trend?: string;
    consecutive_bars?: number;
    trend_strength?: number;
    funding_rate?: number;
    [key: string]: any;
  };

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
