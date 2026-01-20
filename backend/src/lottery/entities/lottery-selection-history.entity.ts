import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm';

@Entity('lottery_selection_history')
export class LotterySelectionHistory {
  @PrimaryGeneratedColumn()
  id: number;

  @CreateDateColumn()
  execution_time: Date;

  @Column({ type: 'int' })
  total_candidates: number;

  @Column({ type: 'text', array: true })
  selected_symbols: string[];

  @Column({ type: 'int', array: true })
  selected_scores: number[];

  @Column({ type: 'jsonb' })
  all_candidates: any;
}
