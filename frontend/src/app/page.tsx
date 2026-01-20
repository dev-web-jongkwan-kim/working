import Link from 'next/link';
import { SystemControl } from '@/components/dashboard/SystemControl';
import { ActiveTradesPanel } from '@/components/dashboard/ActiveTradesPanel';
import { LotteryOrdersPanel } from '@/components/dashboard/LotteryOrdersPanel';
import { OpenOrdersPanel } from '@/components/dashboard/OpenOrdersPanel';
import { ClosedTradesPanel } from '@/components/dashboard/ClosedTradesPanel';
import { getActivePositions, getClosedTrades, getPerformanceSummary, getOpenOrders } from '@/lib/api/trades';
import { getActiveLotteryOrders } from '@/lib/api/lottery';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [activePositions, lotteryOrders, openOrders, closedTrades, performance] = await Promise.all([
    getActivePositions(),
    getActiveLotteryOrders(),
    getOpenOrders(),
    getClosedTrades(20),
    getPerformanceSummary(),
  ]);

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-[1800px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">
                Quad-Strategy Trading System
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Real-time cryptocurrency trading dashboard
              </p>
            </div>
            <div className="flex items-center gap-4">
              <Link
                href="/stats"
                className="btn-secondary flex items-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                Statistics
              </Link>
              <div className="text-right">
                <div className="text-xs text-muted-foreground">Last Update</div>
                <div className="text-sm font-medium">
                  {new Date().toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto px-6 py-6 space-y-6">
        {/* System Control */}
        <SystemControl />

        {/* Performance Summary */}
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

        {/* Lottery Orders Panel */}
        <LotteryOrdersPanel initialOrders={lotteryOrders} />

        {/* Open Orders Panel */}
        <OpenOrdersPanel initialOrders={openOrders} />

        {/* Active Trades Panel */}
        <ActiveTradesPanel initialPositions={activePositions} />

        {/* Closed Trades Panel */}
        <ClosedTradesPanel trades={closedTrades} />
      </div>
    </main>
  );
}
