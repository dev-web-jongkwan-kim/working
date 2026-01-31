'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
} from 'recharts';
import {
  BacktestRun,
  BacktestTrade,
  EquityCurvePoint,
  DailyStats,
  getBacktest,
  getBacktestTrades,
  getEquityCurve,
  getDailyStats,
} from '@/lib/api/backtest';

interface PageParams {
  id: string;
}

export default function BacktestDetailPage({ params }: { params: PageParams }) {
  const { id } = params;
  const [backtest, setBacktest] = useState<BacktestRun | null>(null);
  const [trades, setTrades] = useState<BacktestTrade[]>([]);
  const [equityCurve, setEquityCurve] = useState<EquityCurvePoint[]>([]);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [tradesTotal, setTradesTotal] = useState(0);
  const [tradesPage, setTradesPage] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [btData, tradesData, equityData, dailyData] = await Promise.all([
          getBacktest(id),
          getBacktestTrades(id, 50, 0),
          getEquityCurve(id),
          getDailyStats(id),
        ]);

        setBacktest(btData);
        setTrades(tradesData.trades);
        setTradesTotal(tradesData.total);
        setEquityCurve(equityData.data);
        setDailyStats(dailyData.data);
      } catch (error) {
        console.error('Failed to fetch data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id]);

  const loadMoreTrades = async () => {
    const nextPage = tradesPage + 1;
    const data = await getBacktestTrades(id, 50, nextPage * 50);
    setTrades((prev) => [...prev, ...data.trades]);
    setTradesPage(nextPage);
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-background">
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">로딩 중...</p>
          </div>
        </div>
      </main>
    );
  }

  if (!backtest) {
    return (
      <main className="min-h-screen bg-background">
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <p className="text-muted-foreground">백테스트를 찾을 수 없습니다.</p>
            <Link href="/backtest" className="text-primary hover:underline mt-4 block">
              목록으로 돌아가기
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const formatCurrency = (value: number | null | undefined) => {
    if (value == null) return '-';
    return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  const formatPercent = (value: number | null | undefined) => {
    if (value == null) return '-';
    return `${Number(value).toFixed(2)}%`;
  };

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-6 py-4">
          <div className="flex items-center gap-4">
            <Link
              href="/backtest"
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
            </Link>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{backtest.name}</h1>
              <p className="text-sm text-muted-foreground mt-1">
                {backtest.symbols.join(', ')} | {backtest.strategies.join(', ')} |{' '}
                {new Date(backtest.startDate).toLocaleDateString()} ~ {new Date(backtest.endDate).toLocaleDateString()}
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto px-6 py-6 space-y-6">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">초기 자본</div>
            <div className="text-xl font-bold mt-1">{formatCurrency(backtest.initialBalance)}</div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">최종 자본</div>
            <div className="text-xl font-bold mt-1">{formatCurrency(backtest.finalBalance)}</div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">총 PnL</div>
            <div className={`text-xl font-bold mt-1 ${
              backtest.totalPnl && backtest.totalPnl > 0 ? 'text-green-500' : backtest.totalPnl && backtest.totalPnl < 0 ? 'text-red-500' : ''
            }`}>
              {formatCurrency(backtest.totalPnl)}
            </div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">수익률</div>
            <div className={`text-xl font-bold mt-1 ${
              backtest.totalPnlPercent && backtest.totalPnlPercent > 0 ? 'text-green-500' : backtest.totalPnlPercent && backtest.totalPnlPercent < 0 ? 'text-red-500' : ''
            }`}>
              {formatPercent(backtest.totalPnlPercent)}
            </div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">승률</div>
            <div className="text-xl font-bold mt-1">{formatPercent(backtest.winRate)}</div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">총 거래</div>
            <div className="text-xl font-bold mt-1">{backtest.totalTrades ?? 0}</div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">최대 낙폭</div>
            <div className="text-xl font-bold mt-1 text-red-500">{formatPercent(backtest.maxDrawdown)}</div>
          </div>
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="text-sm text-muted-foreground">Profit Factor</div>
            <div className="text-xl font-bold mt-1">
              {backtest.profitFactor != null ? Number(backtest.profitFactor).toFixed(2) : '-'}
            </div>
          </div>
        </div>

        {/* Equity Curve */}
        <div className="bg-card rounded-xl border border-border p-6">
          <h2 className="text-lg font-semibold mb-4">자산 곡선</h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={equityCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="timestamp"
                  tick={{ fill: '#888', fontSize: 11 }}
                  tickFormatter={(value) => new Date(value).toLocaleDateString()}
                />
                <YAxis
                  tick={{ fill: '#888', fontSize: 11 }}
                  tickFormatter={(value) => `$${value.toLocaleString()}`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }}
                  labelFormatter={(value) => new Date(value).toLocaleString()}
                  formatter={(value: number) => [`$${value.toLocaleString()}`, '잔고']}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke="#22c55e"
                  fill="#22c55e"
                  fillOpacity={0.2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Daily PnL Chart */}
        <div className="bg-card rounded-xl border border-border p-6">
          <h2 className="text-lg font-semibold mb-4">일별 손익</h2>
          <div className="h-60">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyStats}>
                <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#888', fontSize: 11 }}
                />
                <YAxis
                  tick={{ fill: '#888', fontSize: 11 }}
                  tickFormatter={(value) => `$${value}`}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#1a1a1a', border: '1px solid #333' }}
                  formatter={(value: number, name: string) => {
                    if (name === 'pnl') return [`$${value.toFixed(2)}`, 'PnL'];
                    return [value, name];
                  }}
                />
                <Bar dataKey="pnl" name="pnl">
                  {dailyStats.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.pnl >= 0 ? '#22c55e' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Trades Table */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-lg font-semibold">거래 내역 ({tradesTotal}건)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm font-semibold">심볼</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold">전략</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold">방향</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold">진입가</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold">청산가</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold">레버리지</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold">마진</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold">청산사유</th>
                  <th className="text-right px-4 py-3 text-sm font-semibold">PnL</th>
                  <th className="text-left px-4 py-3 text-sm font-semibold">진입시간</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade) => (
                  <tr key={trade.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3 font-medium">{trade.symbol}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{trade.strategy}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        trade.direction === 'LONG' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'
                      }`}>
                        {trade.direction}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm">{Number(trade.entryPrice).toFixed(4)}</td>
                    <td className="px-4 py-3 text-right font-mono text-sm">
                      {trade.exitPrice ? Number(trade.exitPrice).toFixed(4) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-sm">{trade.leverage}x</td>
                    <td className="px-4 py-3 text-right font-mono text-sm">${Number(trade.marginUsd).toFixed(2)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{trade.closeReason || '-'}</td>
                    <td className={`px-4 py-3 text-right font-mono text-sm font-medium ${
                      trade.pnlUsd && Number(trade.pnlUsd) > 0 ? 'text-green-500' : trade.pnlUsd && Number(trade.pnlUsd) < 0 ? 'text-red-500' : ''
                    }`}>
                      {trade.pnlUsd != null ? `$${Number(trade.pnlUsd).toFixed(2)}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {new Date(trade.entryTime).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {trades.length < tradesTotal && (
            <div className="px-6 py-4 border-t border-border text-center">
              <button
                onClick={loadMoreTrades}
                className="text-primary hover:underline"
              >
                더 보기 ({trades.length} / {tradesTotal})
              </button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
