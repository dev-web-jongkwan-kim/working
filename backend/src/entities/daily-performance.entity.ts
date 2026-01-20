import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('daily_performance')
@Index(['date'])
export class DailyPerformance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'date', unique: true })
  date: Date;

  // Trade statistics
  @Column('int', { default: 0 })
  total_trades: number;

  @Column('int', { default: 0 })
  winning_trades: number;

  @Column('int', { default: 0 })
  losing_trades: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  win_rate: number; // percentage

  // P&L
  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  total_pnl: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  gross_profit: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  gross_loss: number;

  @Column('decimal', { precision: 10, scale: 4, default: 0 })
  pnl_percent: number; // ROI percentage

  // Best/Worst trades
  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  best_trade_pnl: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  worst_trade_pnl: number;

  @Column({ nullable: true })
  best_trade_id: string;

  @Column({ nullable: true })
  worst_trade_id: string;

  // Strategy breakdown
  @Column('int', { default: 0 })
  cycle_rider_trades: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  cycle_rider_pnl: number;

  @Column('int', { default: 0 })
  hour_swing_trades: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  hour_swing_pnl: number;

  // Exposure
  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  max_concurrent_positions: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  avg_position_size: number;

  @Column('decimal', { precision: 20, scale: 8, default: 0 })
  total_volume: number;

  // Risk metrics
  @Column('int', { default: 0 })
  risk_events: number;

  @Column('decimal', { precision: 10, scale: 4, default: 0 })
  max_drawdown_percent: number;

  // Market regime
  @Column({ nullable: true })
  dominant_regime: string; // Most common regime for the day

  @Column('jsonb', { nullable: true })
  metadata: {
    regime_distribution?: { [key: string]: number };
    symbols_traded?: string[];
    avg_hold_time?: number;
    [key: string]: any;
  };

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
