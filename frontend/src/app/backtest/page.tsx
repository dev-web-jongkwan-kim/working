'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  BacktestRun,
  Strategy,
  getAllBacktests,
  getAvailableSymbols,
  getAvailableStrategies,
  createBacktest,
  deleteBacktest,
} from '@/lib/api/backtest';

export default function BacktestPage() {
  const [backtests, setBacktests] = useState<BacktestRun[]>([]);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    symbols: [] as string[],
    strategies: [] as string[],
    startDate: '',
    endDate: '',
    initialBalance: 10000,
  });

  const fetchData = async () => {
    try {
      const [backTestData, symbolData, strategyData] = await Promise.all([
        getAllBacktests(50, 0),
        getAvailableSymbols(),
        getAvailableStrategies(),
      ]);

      setBacktests(backTestData.runs);
      setSymbols(symbolData.symbols);
      setStrategies(strategyData.strategies);
    } catch (error) {
      console.error('Failed to fetch data:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Poll for updates
    const interval = setInterval(async () => {
      const data = await getAllBacktests(50, 0);
      setBacktests(data.runs);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const handleCreate = async () => {
    if (!formData.name || formData.symbols.length === 0 || formData.strategies.length === 0 || !formData.startDate || !formData.endDate) {
      alert('모든 필드를 입력해주세요.');
      return;
    }

    setCreating(true);
    try {
      await createBacktest(formData);
      setShowCreateModal(false);
      setFormData({
        name: '',
        symbols: [],
        strategies: [],
        startDate: '',
        endDate: '',
        initialBalance: 10000,
      });
      fetchData();
    } catch (error) {
      console.error('Failed to create backtest:', error);
      alert('백테스트 생성에 실패했습니다.');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    await deleteBacktest(id);
    fetchData();
  };

  const toggleSymbol = (symbol: string) => {
    setFormData((prev) => ({
      ...prev,
      symbols: prev.symbols.includes(symbol)
        ? prev.symbols.filter((s) => s !== symbol)
        : [...prev.symbols, symbol],
    }));
  };

  const toggleStrategy = (strategyId: string) => {
    setFormData((prev) => ({
      ...prev,
      strategies: prev.strategies.includes(strategyId)
        ? prev.strategies.filter((s) => s !== strategyId)
        : [...prev.strategies, strategyId],
    }));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return 'text-green-500';
      case 'RUNNING':
      case 'DOWNLOADING':
        return 'text-yellow-500';
      case 'FAILED':
        return 'text-red-500';
      default:
        return 'text-gray-500';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'PENDING':
        return '대기중';
      case 'DOWNLOADING':
        return '데이터 다운로드';
      case 'RUNNING':
        return '실행중';
      case 'COMPLETED':
        return '완료';
      case 'FAILED':
        return '실패';
      default:
        return status;
    }
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
                <h1 className="text-2xl font-bold tracking-tight">백테스트</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  과거 데이터로 전략 성과 분석
                </p>
              </div>
            </div>

            <button
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium"
            >
              + 새 백테스트
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-[1800px] mx-auto px-6 py-6">
        {/* Backtest List */}
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-6 py-4 text-sm font-semibold">이름</th>
                <th className="text-left px-6 py-4 text-sm font-semibold">심볼</th>
                <th className="text-left px-6 py-4 text-sm font-semibold">전략</th>
                <th className="text-left px-6 py-4 text-sm font-semibold">기간</th>
                <th className="text-left px-6 py-4 text-sm font-semibold">상태</th>
                <th className="text-right px-6 py-4 text-sm font-semibold">PnL</th>
                <th className="text-right px-6 py-4 text-sm font-semibold">승률</th>
                <th className="text-right px-6 py-4 text-sm font-semibold">거래수</th>
                <th className="text-center px-6 py-4 text-sm font-semibold">액션</th>
              </tr>
            </thead>
            <tbody>
              {backtests.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-muted-foreground">
                    백테스트가 없습니다. 새로 만들어보세요.
                  </td>
                </tr>
              ) : (
                backtests.map((bt) => (
                  <tr key={bt.id} className="border-t border-border hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4">
                      <Link href={`/backtest/${bt.id}`} className="font-medium hover:text-primary">
                        {bt.name}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {bt.symbols.slice(0, 3).join(', ')}
                      {bt.symbols.length > 3 && ` +${bt.symbols.length - 3}`}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {bt.strategies.join(', ')}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground">
                      {new Date(bt.startDate).toLocaleDateString()} ~ {new Date(bt.endDate).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <span className={`text-sm font-medium ${getStatusColor(bt.status)}`}>
                        {getStatusText(bt.status)}
                        {(bt.status === 'RUNNING' || bt.status === 'DOWNLOADING') && bt.progress && (
                          <span className="ml-2">({bt.progress}%)</span>
                        )}
                      </span>
                      {bt.currentStep && bt.status !== 'COMPLETED' && bt.status !== 'FAILED' && (
                        <div className="text-xs text-muted-foreground mt-1">{bt.currentStep}</div>
                      )}
                    </td>
                    <td className={`px-6 py-4 text-right font-mono ${
                      bt.totalPnl && bt.totalPnl > 0 ? 'text-green-500' : bt.totalPnl && bt.totalPnl < 0 ? 'text-red-500' : ''
                    }`}>
                      {bt.totalPnl != null ? `$${Number(bt.totalPnl).toFixed(2)}` : '-'}
                    </td>
                    <td className="px-6 py-4 text-right font-mono">
                      {bt.winRate != null ? `${Number(bt.winRate).toFixed(1)}%` : '-'}
                    </td>
                    <td className="px-6 py-4 text-right font-mono">
                      {bt.totalTrades ?? '-'}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className="flex items-center justify-center gap-2">
                        {bt.status === 'COMPLETED' && (
                          <Link
                            href={`/backtest/${bt.id}`}
                            className="text-sm text-primary hover:underline"
                          >
                            상세보기
                          </Link>
                        )}
                        <button
                          onClick={() => handleDelete(bt.id)}
                          className="text-sm text-red-500 hover:underline"
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-card rounded-xl border border-border p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="text-xl font-bold mb-6">새 백테스트 생성</h2>

            <div className="space-y-6">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium mb-2">이름</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="예: BTC 12월 테스트"
                />
              </div>

              {/* Symbols */}
              <div>
                <label className="block text-sm font-medium mb-2">심볼 선택</label>
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 border border-border rounded-lg">
                  {symbols.map((symbol) => (
                    <button
                      key={symbol}
                      onClick={() => toggleSymbol(symbol)}
                      className={`px-3 py-1 rounded-full text-sm transition-colors ${
                        formData.symbols.includes(symbol)
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted hover:bg-muted/80'
                      }`}
                    >
                      {symbol.replace('USDT', '')}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  선택됨: {formData.symbols.length}개
                </p>
              </div>

              {/* Strategies */}
              <div>
                <label className="block text-sm font-medium mb-2">전략 선택</label>
                <div className="space-y-2">
                  {strategies.map((strategy) => (
                    <button
                      key={strategy.id}
                      onClick={() => toggleStrategy(strategy.id)}
                      className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                        formData.strategies.includes(strategy.id)
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <div className="font-medium">{strategy.name}</div>
                      <div className="text-sm text-muted-foreground">{strategy.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Date Range */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-2">시작일</label>
                  <input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) => setFormData((prev) => ({ ...prev, startDate: e.target.value }))}
                    className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">종료일</label>
                  <input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) => setFormData((prev) => ({ ...prev, endDate: e.target.value }))}
                    className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
              </div>

              {/* Initial Balance */}
              <div>
                <label className="block text-sm font-medium mb-2">초기 자본 (USD)</label>
                <input
                  type="number"
                  value={formData.initialBalance}
                  onChange={(e) => setFormData((prev) => ({ ...prev, initialBalance: Number(e.target.value) }))}
                  className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                  min={100}
                  step={100}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-4 mt-8">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleCreate}
                disabled={creating}
                className="px-6 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium disabled:opacity-50"
              >
                {creating ? '생성 중...' : '백테스트 시작'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
