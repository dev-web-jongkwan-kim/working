import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { BacktestRun } from './backtest-run.entity';

export enum TradeDirection {
  LONG = 'LONG',
  SHORT = 'SHORT',
}

export enum TradeStatus {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
}

export enum CloseReason {
  TP1 = 'TP1',
  TP2 = 'TP2',
  SL = 'SL',
  TRAILING_SL = 'TRAILING_SL',
  MANUAL = 'MANUAL',
  END_OF_BACKTEST = 'END_OF_BACKTEST',
  TIME_BASED = 'TIME_BASED',
  OPPOSITE_SIGNAL = 'OPPOSITE_SIGNAL',
  EMERGENCY = 'EMERGENCY',
  LIQUIDATION = 'LIQUIDATION',
}

@Entity('backtest_trades')
export class BacktestTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => BacktestRun, (run) => run.trades, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'backtest_run_id' })
  backtestRun: BacktestRun;

  @Column()
  @Index()
  backtest_run_id: string;

  @Column()
  symbol: string;

  @Column()
  strategy: string;

  @Column({ nullable: true })
  subStrategy: string;

  @Column({
    type: 'enum',
    enum: TradeDirection,
  })
  direction: TradeDirection;

  @Column('decimal', { precision: 20, scale: 8 })
  entryPrice: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  exitPrice: number;

  @Column('decimal', { precision: 20, scale: 8 })
  slPrice: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp1Price: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  tp2Price: number;

  @Column('int')
  leverage: number;

  @Column('decimal', { precision: 20, scale: 2 })
  marginUsd: number;

  @Column('decimal', { precision: 20, scale: 8 })
  positionSize: number;

  @Column('timestamp')
  entryTime: Date;

  @Column('timestamp', { nullable: true })
  exitTime: Date;

  @Column({
    type: 'enum',
    enum: TradeStatus,
    default: TradeStatus.OPEN,
  })
  status: TradeStatus;

  @Column({
    type: 'enum',
    enum: CloseReason,
    nullable: true,
  })
  closeReason: CloseReason;

  @Column('decimal', { precision: 20, scale: 2, nullable: true })
  pnlUsd: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  pnlPercent: number;

  @Column('decimal', { precision: 10, scale: 4, nullable: true })
  signalConfidence: number;

  @Column({ nullable: true })
  marketRegime: string;

  @Column('jsonb', { nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn()
  createdAt: Date;
}
