import { StrategyType, TradeDirection } from '../../entities/trade.entity';

export interface TradingSignal {
  detected: boolean;
  strategyType: StrategyType;
  subStrategy: string;
  symbol: string;
  direction: TradeDirection;
  entryPrice: number;
  slPrice: number;
  tp1Price?: number;
  tp2Price?: number;
  useTrailing?: boolean;
  confidence: number;
  riskRewardRatio?: number;
  marketRegime?: string;
  metadata?: {
    atr?: number;
    rsi?: number;
    cvdTrend?: string;
    consecutiveBars?: number;
    trendStrength?: number;
    fundingRate?: number;
    [key: string]: any;
  };
}
