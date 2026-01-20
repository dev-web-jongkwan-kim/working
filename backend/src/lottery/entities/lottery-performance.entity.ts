import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('lottery_performance')
export class LotteryPerformance {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'date', unique: true })
  date: Date;

  @Column({ type: 'int', default: 0 })
  orders_placed: number;

  @Column({ type: 'int', default: 0 })
  orders_filled: number;

  @Column({ type: 'int', default: 0 })
  orders_cancelled: number;

  @Column({ type: 'decimal', precision: 20, scale: 8, default: 0 })
  total_pnl: number;

  @Column({ type: 'decimal', precision: 5, scale: 4, nullable: true })
  win_rate: number;

  @Column({ type: 'jsonb', nullable: true })
  best_trade: any;

  @Column({ type: 'jsonb', nullable: true })
  worst_trade: any;
}
