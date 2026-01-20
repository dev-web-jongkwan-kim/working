const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface Trade {
  id: string;
  trade_id: string;
  strategy_type: string;
  sub_strategy: string;
  symbol: string;
  direction: string;
  entry_price: number;
  exit_price: number | null;
  sl_price: number;
  tp1_price: number | null;
  tp2_price: number | null;
  leverage: number;
  margin_usd: number;
  position_size: number;
  entry_time: string;
  exit_time: string | null;
  pnl_usd: number;
  pnl_percent: number;
  status: string;
  close_reason: string | null;
  signal_confidence: number;
  market_regime: string | null;
}

export interface Position {
  id: string;
  position_id: string;
  trade_id: string;
  strategy_type: string;
  sub_strategy?: string;
  symbol: string;
  direction: string;
  status: string;
  entry_price: number;
  current_price: number;
  leverage: number;
  margin_usd: number;
  unrealized_pnl: number;
  unrealized_pnl_percent: number;
  tp1_filled?: boolean;
  tp2_filled?: boolean;
  entry_time: string;
}

export async function getActiveTrades(): Promise<Trade[]> {
  const res = await fetch(`${API_URL}/api/trades/active`);
  return res.json();
}

export async function getClosedTrades(limit = 50): Promise<Trade[]> {
  const res = await fetch(`${API_URL}/api/trades/closed?limit=${limit}`);
  return res.json();
}

export async function getActivePositions(): Promise<Position[]> {
  const res = await fetch(`${API_URL}/api/positions/active`);
  return res.json();
}

export async function getPerformanceSummary() {
  const res = await fetch(`${API_URL}/api/trades/performance`);
  return res.json();
}

export interface OpenOrder {
  orderId: number;
  symbol: string;
  side: string;
  type: string;
  price: number;
  stopPrice: number;
  origQty: number;
  executedQty: number;
  status: string;
  timeInForce: string;
  reduceOnly: boolean;
  closePosition: boolean;
  time: number;
  updateTime: number;
}

export async function getOpenOrders(): Promise<OpenOrder[]> {
  const res = await fetch(`${API_URL}/api/trades/orders/open`);
  return res.json();
}

export interface DailyStats {
  date: string;
  trades: Trade[];
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  totalPnlPercent: number;
}

export async function getDailyStats(): Promise<DailyStats[]> {
  const res = await fetch(`${API_URL}/api/trades/stats/daily`);
  return res.json();
}
