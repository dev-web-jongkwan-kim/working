'use client';

import { useEffect, useState } from 'react';
import { getPerformanceSummary, PerformanceSummary } from '@/lib/api/trades';

export function PerformanceSummaryPanel() {
  const [performance, setPerformance] = useState<PerformanceSummary>({
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalPnl: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const data = await getPerformanceSummary();
        setPerformance(data);
      } catch (error) {
        console.error('Failed to fetch performance:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 10000); // Refresh every 10 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="stats-card animate-pulse">
            <div className="h-4 bg-muted rounded w-24 mb-2"></div>
            <div className="h-8 bg-muted rounded w-16"></div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      <div className="stats-card">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">Total Trades</div>
          <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <div className="text-3xl font-bold">{performance.totalTrades}</div>
        <div className="text-xs text-muted-foreground mt-1">All time</div>
      </div>

      <div className="stats-card">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">Win Rate</div>
          <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <div className="text-3xl font-bold">{performance.winRate.toFixed(1)}%</div>
        <div className={`text-xs mt-1 ${performance.winRate >= 50 ? 'profit-positive' : 'profit-negative'}`}>
          {performance.winRate >= 50 ? '↑ Above target' : '↓ Below target'}
        </div>
      </div>

      <div className="stats-card">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">Total P&L</div>
          <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className={`text-3xl font-bold ${performance.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
          ${Math.abs(performance.totalPnl).toFixed(2)}
        </div>
        <div className={`text-xs mt-1 ${performance.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
          {performance.totalPnl >= 0 ? '↑ Profit' : '↓ Loss'}
        </div>
      </div>

      <div className="stats-card">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm text-muted-foreground">Profit Factor</div>
          <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="text-3xl font-bold">{performance.profitFactor.toFixed(2)}</div>
        <div className={`text-xs mt-1 ${performance.profitFactor >= 1.5 ? 'profit-positive' : 'text-muted-foreground'}`}>
          {performance.profitFactor >= 1.5 ? '↑ Good' : 'Target: 1.5+'}
        </div>
      </div>
    </div>
  );
}
