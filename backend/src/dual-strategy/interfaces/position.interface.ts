import { StrategyType, TradeDirection } from '../../entities/trade.entity';

export interface ActivePosition {
  positionId: string;
  tradeId: string;
  strategyType: StrategyType;
  subStrategy: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  currentPrice: number;
  slPrice: number;
  tp1Price?: number;
  tp2Price?: number;
  leverage: number;
  marginUsd: number;
  positionSize: number;
  remainingSize: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  tp1Filled: boolean;
  tp2Filled: boolean;
  trailingEnabled: boolean;
  trailingStopPrice?: number;
  entryTime: Date;
  lastUpdateTime: Date;
}
