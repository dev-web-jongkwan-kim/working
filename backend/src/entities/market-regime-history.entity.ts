import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

export enum MarketRegime {
  STRONG_UPTREND = 'STRONG_UPTREND',
  WEAK_UPTREND = 'WEAK_UPTREND',
  SIDEWAYS = 'SIDEWAYS',
  WEAK_DOWNTREND = 'WEAK_DOWNTREND',
  STRONG_DOWNTREND = 'STRONG_DOWNTREND',
}

@Entity('market_regime_history')
@Index(['created_at'])
export class MarketRegimeHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: MarketRegime,
  })
  @Index()
  regime: MarketRegime;

  @Column('decimal', { precision: 10, scale: 4 })
  trend_strength: number; // 0-1

  @Column('decimal', { precision: 20, scale: 8 })
  btc_price: number;

  @Column('decimal', { precision: 10, scale: 4 })
  btc_volatility: number; // ATR percentage

  // Strategy weights for this regime
  @Column('decimal', { precision: 5, scale: 2 })
  cycle_rider_weight: number;

  @Column('decimal', { precision: 5, scale: 2 })
  hour_swing_weight: number;

  @Column('jsonb', { nullable: true })
  metadata: {
    rsi?: number;
    volume?: number;
    [key: string]: any;
  };

  @CreateDateColumn()
  created_at: Date;
}
