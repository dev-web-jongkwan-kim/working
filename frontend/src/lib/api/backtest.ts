const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4040';

export interface BacktestRun {
  id: string;
  name: string;
  symbols: string[];
  strategies: string[];
  startDate: string;
  endDate: string;
  initialBalance: number;
  status: 'PENDING' | 'DOWNLOADING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  progress: number;
  currentStep: string;
  errorMessage?: string;
  finalBalance?: number;
  totalTrades?: number;
  winningTrades?: number;
  losingTrades?: number;
  winRate?: number;
  totalPnl?: number;
  totalPnlPercent?: number;
  maxDrawdown?: number;
  sharpeRatio?: number;
  profitFactor?: number;
  createdAt: string;
  updatedAt: string;
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  strategy: string;
  subStrategy?: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  slPrice: number;
  tp1Price?: number;
  tp2Price?: number;
  leverage: number;
  marginUsd: number;
  positionSize: number;
  entryTime: string;
  exitTime?: string;
  status: 'OPEN' | 'CLOSED';
  closeReason?: string;
  pnlUsd?: number;
  pnlPercent?: number;
  signalConfidence?: number;
  marketRegime?: string;
}

export interface CreateBacktestDto {
  name: string;
  symbols: string[];
  strategies: string[];
  startDate: string;
  endDate: string;
  initialBalance: number;
}

export interface EquityCurvePoint {
  timestamp: string;
  balance: number;
  drawdown: number;
}

export interface DailyStats {
  date: string;
  trades: number;
  pnl: number;
  winRate: number;
}

export interface Strategy {
  id: string;
  name: string;
  description: string;
}

export async function getAvailableSymbols(): Promise<{ symbols: string[] }> {
  const res = await fetch(`${API_URL}/api/backtest/available-symbols`);
  return res.json();
}

export async function getAvailableStrategies(): Promise<{ strategies: Strategy[] }> {
  const res = await fetch(`${API_URL}/api/backtest/available-strategies`);
  return res.json();
}

export async function createBacktest(dto: CreateBacktestDto): Promise<BacktestRun> {
  const res = await fetch(`${API_URL}/api/backtest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  });
  return res.json();
}

export async function getAllBacktests(
  limit: number = 20,
  offset: number = 0
): Promise<{ runs: BacktestRun[]; total: number }> {
  const res = await fetch(`${API_URL}/api/backtest?limit=${limit}&offset=${offset}`);
  return res.json();
}

export async function getBacktest(id: string): Promise<BacktestRun | null> {
  const res = await fetch(`${API_URL}/api/backtest/${id}`);
  if (!res.ok) return null;
  return res.json();
}

export async function getBacktestTrades(
  id: string,
  limit: number = 100,
  offset: number = 0
): Promise<{ trades: BacktestTrade[]; total: number }> {
  const res = await fetch(`${API_URL}/api/backtest/${id}/trades?limit=${limit}&offset=${offset}`);
  return res.json();
}

export async function getEquityCurve(id: string): Promise<{ data: EquityCurvePoint[] }> {
  const res = await fetch(`${API_URL}/api/backtest/${id}/equity-curve`);
  return res.json();
}

export async function getDailyStats(id: string): Promise<{ data: DailyStats[] }> {
  const res = await fetch(`${API_URL}/api/backtest/${id}/daily-stats`);
  return res.json();
}

export async function deleteBacktest(id: string): Promise<{ success: boolean }> {
  const res = await fetch(`${API_URL}/api/backtest/${id}`, { method: 'DELETE' });
  return res.json();
}
