import Link from 'next/link';
import { getPerformanceSummary, getDailyStats } from '@/lib/api/trades';
import { DailyTradesPanel } from '@/components/stats/DailyTradesPanel';

export const dynamic = 'force-dynamic';

export default async function StatsPage() {
  const [performance, dailyStats] = await Promise.all([
    getPerformanceSummary(),
    getDailyStats(),
  ]);

  // Calculate total profit percent
  const totalPnlPercent = dailyStats.reduce((sum, d) => sum + d.totalPnlPercent, 0);

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-[1800px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-4">
                <Link
                  href="/"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                  </svg>
                </Link>
                <div>
                  <h1 className="text-2xl font-bold tracking-tight">
                    Trading Statistics
                  </h1>
                  <p className="text-sm text-muted-foreground mt-1">
                    Cumulative performance and daily breakdown
                  </p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-xs text-muted-foreground">Data Period</div>
                <div className="text-sm font-medium">
                  {dailyStats.length > 0
                    ? `${dailyStats[dailyStats.length - 1]?.date || 'N/A'} ~ ${dailyStats[0]?.date || 'N/A'}`
                    : 'No data'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto px-6 py-6 space-y-6">
        {/* Cumulative Performance Cards */}
        <div className="trading-card p-6">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Cumulative Performance
          </h2>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Total Trades</div>
              <div className="text-3xl font-bold">{performance.totalTrades}</div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Winning Trades</div>
              <div className="text-3xl font-bold profit-positive">{performance.winningTrades}</div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Losing Trades</div>
              <div className="text-3xl font-bold profit-negative">{performance.losingTrades}</div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Win Rate</div>
              <div className={`text-3xl font-bold ${performance.winRate >= 50 ? 'profit-positive' : 'profit-negative'}`}>
                {performance.winRate.toFixed(1)}%
              </div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Total P&L</div>
              <div className={`text-3xl font-bold ${performance.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
                {performance.totalPnl >= 0 ? '+' : ''}${performance.totalPnl.toFixed(2)}
              </div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Total P&L %</div>
              <div className={`text-3xl font-bold ${totalPnlPercent >= 0 ? 'profit-positive' : 'profit-negative'}`}>
                {totalPnlPercent >= 0 ? '+' : ''}{totalPnlPercent.toFixed(2)}%
              </div>
            </div>
          </div>

          {/* Additional Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 pt-4 border-t border-border">
            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Profit Factor</div>
              <div className={`text-2xl font-bold ${performance.profitFactor >= 1.5 ? 'profit-positive' : 'text-muted-foreground'}`}>
                {performance.profitFactor.toFixed(2)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Target: 1.5+</div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Avg Win</div>
              <div className="text-2xl font-bold profit-positive">
                +${performance.avgWin.toFixed(2)}
              </div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Avg Loss</div>
              <div className="text-2xl font-bold profit-negative">
                -${performance.avgLoss.toFixed(2)}
              </div>
            </div>

            <div className="stats-card">
              <div className="text-sm text-muted-foreground mb-1">Trading Days</div>
              <div className="text-2xl font-bold">
                {dailyStats.length}
              </div>
            </div>
          </div>
        </div>

        {/* Daily Breakdown */}
        <div className="trading-card p-6">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            Daily Breakdown
          </h2>

          {dailyStats.length === 0 ? (
            <div className="text-center py-12">
              <svg className="w-16 h-16 mx-auto text-muted-foreground/50 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-muted-foreground">No trading data available</p>
              <p className="text-sm text-muted-foreground mt-1">Daily statistics will appear here after trades are closed</p>
            </div>
          ) : (
            <div className="space-y-4">
              {dailyStats.map((day) => (
                <DailyTradesPanel key={day.date} dailyData={day} />
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
