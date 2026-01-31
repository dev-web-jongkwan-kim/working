const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4040';

export interface AccountSummary {
  balance: number;
  availableBalance: number;
  unrealizedPnl: number;
  marginBalance: number;
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
}

export interface ManualTrade {
  id: string;
  tranId: string;
  symbol: string;
  incomeType: string;
  income: number;
  asset: string;
  time: string;
  info: string;
}

export interface DailySummary {
  date: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  pnl: number;
}

export interface DailySummaryResponse {
  days: DailySummary[];
  summary: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
  };
}

export interface EquityCurvePoint {
  time: string;
  symbol: string;
  pnl: number;
  balance: number;
}

export interface EquityCurveResponse {
  startingBalance: number;
  currentBalance: number;
  totalPnl: number;
  curve: EquityCurvePoint[];
}

export interface CalendarDay {
  day: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  pnl: number;
  isProfit: boolean;
  isLoss: boolean;
}

export interface CalendarResponse {
  year: number;
  month: number;
  calendar: CalendarDay[];
  summary: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    profitDays: number;
    lossDays: number;
  };
}

export interface SyncResult {
  success: boolean;
  synced?: number;
  skipped?: number;
  total?: number;
  error?: string;
}

export async function getAccountSummary(): Promise<AccountSummary> {
  const res = await fetch(`${API_URL}/api/manual-trading/account`);
  return res.json();
}

export async function syncTrades(days: number = 30): Promise<SyncResult> {
  const res = await fetch(`${API_URL}/api/manual-trading/sync?days=${days}`, {
    method: 'POST',
  });
  return res.json();
}

export async function getTrades(
  startTime?: number,
  endTime?: number
): Promise<ManualTrade[]> {
  const params = new URLSearchParams();
  if (startTime) params.append('startTime', startTime.toString());
  if (endTime) params.append('endTime', endTime.toString());

  const res = await fetch(`${API_URL}/api/manual-trading/trades?${params}`);
  return res.json();
}

export async function getDailySummary(
  days: number = 30
): Promise<DailySummaryResponse> {
  const res = await fetch(
    `${API_URL}/api/manual-trading/daily-summary?days=${days}`
  );
  return res.json();
}

export async function getEquityCurve(
  days: number = 30
): Promise<EquityCurveResponse> {
  const res = await fetch(
    `${API_URL}/api/manual-trading/equity-curve?days=${days}`
  );
  return res.json();
}

export async function getCalendarData(
  year: number,
  month: number
): Promise<CalendarResponse> {
  const res = await fetch(
    `${API_URL}/api/manual-trading/calendar?year=${year}&month=${month}`
  );
  return res.json();
}
