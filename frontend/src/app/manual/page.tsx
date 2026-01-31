'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { SyncButton } from '@/components/manual-trading/SyncButton';
import { StatsCards } from '@/components/manual-trading/StatsCards';
import { EquityChart } from '@/components/manual-trading/EquityChart';
import { TradingCalendar } from '@/components/manual-trading/TradingCalendar';
import {
  AccountSummary,
  DailySummaryResponse,
  EquityCurveResponse,
  getAccountSummary,
  getDailySummary,
  getEquityCurve,
} from '@/lib/api/manual-trading';

export default function ManualTradingPage() {
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [summary, setSummary] = useState<DailySummaryResponse | null>(null);
  const [equityCurve, setEquityCurve] = useState<EquityCurveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [accountData, summaryData, equityData] = await Promise.all([
        getAccountSummary(),
        getDailySummary(365),  // 전체 기간
        getEquityCurve(365),   // 전체 기간
      ]);

      setAccount(accountData);
      setSummary(summaryData);
      setEquityCurve(equityData);
      setLastUpdated(new Date());
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSyncComplete = () => {
    setRefreshTrigger((prev) => prev + 1);
    fetchData();
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-background">
        <div className="flex items-center justify-center h-screen">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">데이터 로딩 중...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
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
                  수동 트레이딩 대시보드
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                  Binance 거래 내역 추적 및 성과 분석
                </p>
              </div>
            </div>

            <div className="flex items-center gap-6">
              <SyncButton onSyncComplete={handleSyncComplete} />

              <div className="text-right">
                <div className="text-xs text-muted-foreground">마지막 업데이트</div>
                <div className="text-sm font-medium">
                  {lastUpdated
                    ? lastUpdated.toLocaleTimeString('ko-KR', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })
                    : '-'}
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto px-6 py-6 space-y-6">
        {/* 주요 지표 카드 */}
        {account && summary && (
          <StatsCards
            account={account}
            summary={summary.summary}
            initialBalance={equityCurve?.startingBalance}
          />
        )}

        {/* Equity Curve 차트 */}
        {equityCurve && <EquityChart data={equityCurve} />}

        {/* 트레이딩 캘린더 */}
        <TradingCalendar refreshTrigger={refreshTrigger} />
      </div>
    </main>
  );
}
