import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { LogLevel } from './strategy-log.entity';

export { LogLevel };

export enum SystemEventType {
  SYSTEM_START = 'SYSTEM_START',
  SYSTEM_STOP = 'SYSTEM_STOP',
  DATA_COLLECTION_START = 'DATA_COLLECTION_START',
  DATA_COLLECTION_ERROR = 'DATA_COLLECTION_ERROR',
  WEBSOCKET_CONNECT = 'WEBSOCKET_CONNECT',
  WEBSOCKET_DISCONNECT = 'WEBSOCKET_DISCONNECT',
  WEBSOCKET_ERROR = 'WEBSOCKET_ERROR',
  DATABASE_CONNECT = 'DATABASE_CONNECT',
  DATABASE_ERROR = 'DATABASE_ERROR',
  REDIS_CONNECT = 'REDIS_CONNECT',
  REDIS_ERROR = 'REDIS_ERROR',
  MARKET_REGIME_UPDATE = 'MARKET_REGIME_UPDATE',
  HEALTH_CHECK = 'HEALTH_CHECK',
}

@Entity('system_logs')
@Index(['log_level', 'created_at'])
@Index(['event_type', 'created_at'])
export class SystemLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: LogLevel,
  })
  @Index()
  log_level: LogLevel;

  @Column({
    type: 'enum',
    enum: SystemEventType,
  })
  @Index()
  event_type: SystemEventType;

  @Column('text')
  message: string;

  @Column({ nullable: true })
  component: string; // Which component generated this log

  @Column('jsonb', { nullable: true })
  metadata: {
    error?: string;
    stack?: string;
    [key: string]: any;
  };

  @CreateDateColumn()
  @Index()
  created_at: Date;
}
