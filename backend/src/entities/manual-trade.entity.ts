import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('manual_trades')
export class ManualTrade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  @Index()
  tranId: string;

  @Column()
  symbol: string;

  @Column()
  incomeType: string;

  @Column('decimal', { precision: 20, scale: 8 })
  income: number;

  @Column({ default: 'USDT' })
  asset: string;

  @Column('timestamp')
  @Index()
  time: Date;

  @Column({ nullable: true })
  info: string;

  @CreateDateColumn()
  created_at: Date;
}
