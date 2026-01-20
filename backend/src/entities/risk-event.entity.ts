import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum RiskEventType {
  DAILY_LOSS_LIMIT = 'DAILY_LOSS_LIMIT',
  CONSECUTIVE_LOSS = 'CONSECUTIVE_LOSS',
  DRAWDOWN_LIMIT = 'DRAWDOWN_LIMIT',
  MAX_POSITIONS = 'MAX_POSITIONS',
  MAX_EXPOSURE = 'MAX_EXPOSURE',
  VOLATILITY_LIMIT = 'VOLATILITY_LIMIT',
  SPREAD_TOO_HIGH = 'SPREAD_TOO_HIGH',
  FUNDING_EXTREME = 'FUNDING_EXTREME',
  MARGIN_INSUFFICIENT = 'MARGIN_INSUFFICIENT',
  COOLDOWN_ACTIVE = 'COOLDOWN_ACTIVE',
}

export enum RiskSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

@Entity('risk_events')
@Index(['event_type', 'created_at'])
@Index(['severity', 'created_at'])
export class RiskEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: RiskEventType,
  })
  @Index()
  event_type: RiskEventType;

  @Column({
    type: 'enum',
    enum: RiskSeverity,
  })
  @Index()
  severity: RiskSeverity;

  @Column('text')
  description: string;

  @Column({ nullable: true })
  @Index()
  symbol: string;

  @Column({ nullable: true })
  trade_id: string;

  @Column({ nullable: true })
  position_id: string;

  // Current values
  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  current_value: number;

  @Column('decimal', { precision: 20, scale: 8, nullable: true })
  limit_value: number;

  // Action taken
  @Column('boolean', { default: false })
  action_taken: boolean;

  @Column({ nullable: true })
  action_description: string;

  @Column('jsonb', { nullable: true })
  metadata: {
    [key: string]: any;
  };

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
