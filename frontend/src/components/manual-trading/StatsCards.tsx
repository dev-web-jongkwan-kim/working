'use client';

import { AccountSummary, DailySummaryResponse } from '@/lib/api/manual-trading';

interface StatsCardsProps {
  account: AccountSummary;
  summary: DailySummaryResponse['summary'];
  initialBalance?: number;
}

export function StatsCards({ account, summary, initialBalance = 0 }: StatsCardsProps) {
  const totalReturn = initialBalance > 0
    ? ((account.balance - initialBalance) / initialBalance) * 100
    : 0;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
      {/* 현재 잔액 */}
      <div className="trading-card p-6 bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/30">
        <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          현재 잔액
        </div>
        <div className="text-4xl font-bold text-blue-400">
          ${account.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>

      {/* 승률 */}
      <div className="trading-card p-6">
        <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          승률
        </div>
        <div className={`text-4xl font-bold ${summary.winRate >= 50 ? 'profit-positive' : 'profit-negative'}`}>
          {summary.winRate.toFixed(1)}%
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {summary.winningTrades}W / {summary.losingTrades}L
        </div>
      </div>

      {/* 거래횟수 */}
      <div className="trading-card p-6">
        <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
          </svg>
          거래횟수
        </div>
        <div className="text-4xl font-bold">
          {summary.totalTrades}
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          최근 30일
        </div>
      </div>

      {/* 수익률 */}
      <div className="trading-card p-6">
        <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          수익률
        </div>
        <div className={`text-4xl font-bold ${totalReturn >= 0 ? 'profit-positive' : 'profit-negative'}`}>
          {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}%
        </div>
      </div>

      {/* 수익금 */}
      <div className={`trading-card p-6 ${summary.totalPnl >= 0 ? 'bg-gradient-to-br from-green-500/10 to-green-600/5 border-green-500/30' : 'bg-gradient-to-br from-red-500/10 to-red-600/5 border-red-500/30'}`}>
        <div className="text-sm text-muted-foreground mb-2 flex items-center gap-2">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          수익금
        </div>
        <div className={`text-4xl font-bold ${summary.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
          {summary.totalPnl >= 0 ? '+' : ''}${summary.totalPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      </div>
    </div>
  );
}
