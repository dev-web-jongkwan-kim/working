'use client';

import { useState } from 'react';
import { syncTrades } from '@/lib/api/manual-trading';

interface SyncButtonProps {
  onSyncComplete: () => void;
}

export function SyncButton({ onSyncComplete }: SyncButtonProps) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);

    try {
      const res = await syncTrades(365);  // 1년치 전체 동기화
      if (res.success) {
        setResult(`${res.synced}건 동기화 완료`);
        onSyncComplete();
      } else {
        setResult(`오류: ${res.error}`);
      }
    } catch (error) {
      setResult('동기화 실패');
    } finally {
      setSyncing(false);
      setTimeout(() => setResult(null), 3000);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleSync}
        disabled={syncing}
        className="btn-primary flex items-center gap-2 px-6 py-3 text-lg font-semibold"
      >
        {syncing ? (
          <>
            <svg
              className="w-5 h-5 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            동기화 중...
          </>
        ) : (
          <>
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            거래내역 동기화
          </>
        )}
      </button>
      {result && (
        <span
          className={`text-sm font-medium ${
            result.includes('오류') || result.includes('실패')
              ? 'text-red-400'
              : 'text-green-400'
          }`}
        >
          {result}
        </span>
      )}
    </div>
  );
}
