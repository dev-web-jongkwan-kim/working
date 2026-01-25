const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4040';

export interface LotteryOrder {
  id: string;
  order_id: string;
  symbol: string;
  entry_price: number;
  depth_from_current: number;
  lottery_score: number;
  status: string; // 'PENDING', 'FILLED', 'CANCELLED', 'CLOSED'
  margin: number;
  quantity: number;
  leverage: number;
  stop_loss_price: number;
  binance_order_id: number;
  stop_loss_order_id?: number;
  filled_at?: string;
  closed_at?: string;
  pnl?: number;
  pnl_pct?: number;
  entry_reason: string;
  expires_at: string;
  created_at: string;
}

export interface LotteryPerformance {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  activeOrders: number;
}

export async function getActiveLotteryOrders(): Promise<LotteryOrder[]> {
  const res = await fetch(`${API_URL}/api/lottery/active`, { cache: 'no-store' });
  return res.json();
}

export async function getClosedLotteryOrders(limit = 50): Promise<LotteryOrder[]> {
  const res = await fetch(`${API_URL}/api/lottery/closed?limit=${limit}`, { cache: 'no-store' });
  return res.json();
}

export async function getLotteryPerformance(): Promise<LotteryPerformance> {
  const res = await fetch(`${API_URL}/api/lottery/performance`, { cache: 'no-store' });
  return res.json();
}
