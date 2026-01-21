import Link from 'next/link';
import { SystemControl } from '@/components/dashboard/SystemControl';
import { ActiveTradesPanel } from '@/components/dashboard/ActiveTradesPanel';
import { LotteryOrdersPanel } from '@/components/dashboard/LotteryOrdersPanel';
import { OpenOrdersPanel } from '@/components/dashboard/OpenOrdersPanel';
import { ClosedTradesPanel } from '@/components/dashboard/ClosedTradesPanel';
import { PerformanceSummaryPanel } from '@/components/dashboard/PerformanceSummaryPanel';

export const dynamic = 'force-dynamic';

export default function HomePage() {
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

        {/* Performance Summary - Client Component */}
        <PerformanceSummaryPanel />

        {/* Lottery Orders Panel - Client Component */}
        <LotteryOrdersPanel initialOrders={[]} />

        {/* Open Orders Panel - Client Component */}
        <OpenOrdersPanel initialOrders={[]} />

        {/* Active Trades Panel - Client Component */}
        <ActiveTradesPanel initialPositions={[]} />

        {/* Closed Trades Panel - Client Component */}
        <ClosedTradesPanel trades={[]} />
      </div>
    </main>
  );
}
