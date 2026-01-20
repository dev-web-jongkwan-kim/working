import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('lottery_orders')
export class LotteryOrder {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar', length: 20 })
  @Index()
  symbol: string;

  // Entry details
  @Column({ type: 'decimal', precision: 20, scale: 8 })
  entry_price: number;

  @Column({ type: 'text' })
  entry_reason: string;

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  depth_from_current: number;

  @Column({ type: 'int' })
  lottery_score: number;

  // Order info
  @Column({ type: 'varchar', length: 50, unique: true, nullable: true })
  order_id: string;

  @Column({ type: 'bigint', nullable: true })
  binance_order_id: number;

  @Column({ type: 'varchar', length: 20 })
  @Index()
  status: string; // 'PENDING', 'FILLED', 'CANCELLED', 'CLOSED'

  // Position details
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 30.0 })
  margin: number;

  @Column({ type: 'decimal', precision: 20, scale: 8 })
  quantity: number;

  @Column({ type: 'int' })
  leverage: number;

  // Risk management
  @Column({ type: 'decimal', precision: 20, scale: 8 })
  stop_loss_price: number;

  @Column({ type: 'bigint', nullable: true })
  stop_loss_order_id: number;

  // Timestamps
  @CreateDateColumn()
  created_at: Date;

  @Column({ type: 'timestamp' })
  @Index()
  expires_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  filled_at: Date;

  @Column({ type: 'timestamp', nullable: true })
  closed_at: Date;

  // Performance
  @Column({ type: 'decimal', precision: 20, scale: 8, nullable: true })
  pnl: number;

  @Column({ type: 'decimal', precision: 10, scale: 4, nullable: true })
  pnl_pct: number;

  @UpdateDateColumn()
  updated_at: Date;
}
