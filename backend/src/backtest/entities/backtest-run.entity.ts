import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { BacktestTrade } from './backtest-trade.entity';

export enum BacktestStatus {
  PENDING = 'PENDING',
  DOWNLOADING = 'DOWNLOADING',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity('backtest_runs')
export class BacktestRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column('simple-array')
  symbols: string[];

  @Column('simple-array')
  strategies: string[];

  @Column('timestamp')
  startDate: Date;

  @Column('timestamp')
  endDate: Date;

  @Column('decimal', { precision: 20, scale: 2 })
  initialBalance: number;

  @Column({
    type: 'enum',
    enum: BacktestStatus,
    default: BacktestStatus.PENDING,
  })
  status: BacktestStatus;

  @Column({ nullable: true })
  progress: number;

  @Column({ nullable: true })
  currentStep: string;

  @Column({ nullable: true })
  errorMessage: string;

  // Results
  @Column('decimal', { precision: 20, scale: 2, nullable: true })
  finalBalance: number;

  @Column('int', { nullable: true })
  totalTrades: number;

  @Column('int', { nullable: true })
  winningTrades: number;

  @Column('int', { nullable: true })
  losingTrades: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  winRate: number;

  @Column('decimal', { precision: 20, scale: 2, nullable: true })
  totalPnl: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  totalPnlPercent: number;

  @Column('decimal', { precision: 10, scale: 2, nullable: true })
  maxDrawdown: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  sharpeRatio: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  profitFactor: number;

  @OneToMany(() => BacktestTrade, (trade) => trade.backtestRun)
  trades: BacktestTrade[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
