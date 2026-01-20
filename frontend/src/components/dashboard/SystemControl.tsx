'use client';

import { useState, useEffect } from 'react';
import { startSystem, stopSystem, getSystemStatus, SystemStatus } from '@/lib/api/system';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

export function SystemControl() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [symbolsOpen, setSymbolsOpen] = useState(false);

  // Market regime descriptions
  const getRegimeDescription = (regime: string | undefined): string => {
    const descriptions: Record<string, string> = {
      'SIDEWAYS': 'Low volatility, range-bound market. Price moving horizontally within defined boundaries.',
      'WEAK_UPTREND': 'Mild bullish momentum. Price making higher highs but with low conviction.',
      'STRONG_UPTREND': 'Strong bullish momentum. Sustained upward price movement with high conviction.',
      'WEAK_DOWNTREND': 'Mild bearish momentum. Price making lower lows but with low conviction.',
      'STRONG_DOWNTREND': 'Strong bearish momentum. Sustained downward price movement with high conviction.',
      'VOLATILE': 'High volatility environment. Rapid price swings with no clear direction.',
      'CONSOLIDATION': 'Price consolidating after a major move. Preparing for next directional move.',
    };
    return descriptions[regime?.toUpperCase() || ''] || 'Market state being analyzed';
  };

  // Fetch initial status
  useEffect(() => {
    fetchStatus();
    // Poll status every 5 seconds
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const data = await getSystemStatus();
      setStatus(data);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch status:', err);
      setError('Failed to fetch system status');
    }
  };

  const handleStart = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await startSystem();
      if (result.success) {
        await fetchStatus();
      } else {
        setError(result.message);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start system');
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await stopSystem();
      if (result.success) {
        await fetchStatus();
      } else {
        setError(result.message);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to stop system');
    } finally {
      setLoading(false);
    }
  };

  if (!status) {
    return (
      <div className="trading-card p-6">
        <div className="flex items-center justify-center">
          <div className="status-loading"></div>
          <span className="text-muted-foreground">Loading system status...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="trading-card p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            {status.isRunning ? (
              <span className="status-running"></span>
            ) : (
              <span className="status-stopped"></span>
            )}
            Trading System
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {status.isRunning ? 'System is running' : 'System is stopped'}
          </p>
        </div>

        {/* Control Buttons */}
        <div className="flex gap-3">
          <button
            onClick={handleStart}
            disabled={loading || status.isRunning}
            className="btn-success disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && status.isRunning === false ? (
              <>
                <span className="status-loading"></span>
                Starting...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Start Trading
              </>
            )}
          </button>

          <button
            onClick={handleStop}
            disabled={loading || !status.isRunning}
            className="btn-danger disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && status.isRunning ? (
              <>
                <span className="status-loading"></span>
                Stopping...
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
                Stop Trading
              </>
            )}
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-4 p-3 bg-destructive/10 border border-destructive/50 rounded-md text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Status Information */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="stats-card">
          <div className="text-sm text-muted-foreground mb-1">Active Positions</div>
          <div className="text-2xl font-bold">{status.activePositions}</div>
        </div>

        <Collapsible open={symbolsOpen} onOpenChange={setSymbolsOpen}>
          <div className="stats-card">
            <div className="flex items-center justify-between mb-1">
              <div className="text-sm text-muted-foreground">Trading Symbols</div>
              <CollapsibleTrigger asChild>
                <button className="p-1 hover:bg-muted rounded transition-colors">
                  <ChevronDown
                    className={`h-4 w-4 transition-transform ${
                      symbolsOpen ? 'transform rotate-180' : ''
                    }`}
                  />
                </button>
              </CollapsibleTrigger>
            </div>
            <div className="text-2xl font-bold">{status.symbols.length}</div>
            <CollapsibleContent>
              <div className="text-xs text-muted-foreground mt-2 max-h-32 overflow-y-auto">
                {status.symbols.join(', ')}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        <div className="stats-card">
          <div className="text-sm text-muted-foreground mb-1">Market Regime</div>
          <div className="text-lg font-semibold capitalize">
            {status.currentRegime?.regime || 'Unknown'}
          </div>
          {status.currentRegime?.volatility && (
            <div className="text-xs text-muted-foreground mt-1">
              Volatility: {(Number(status.currentRegime.volatility || 0) * 100).toFixed(1)}%
            </div>
          )}
          <div className="text-xs text-muted-foreground mt-2 leading-relaxed">
            {getRegimeDescription(status.currentRegime?.regime)}
          </div>
        </div>
      </div>

      {/* Instructions */}
      {!status.isRunning && (
        <div className="mt-4 p-4 bg-muted/50 rounded-md">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 text-primary mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="flex-1">
              <p className="text-sm font-medium mb-1">Ready to start trading</p>
              <p className="text-xs text-muted-foreground">
                Click "Start Trading" to begin automated signal generation and order execution.
                The system will monitor {status.symbols.length} symbols and execute trades based on Cycle Rider and Hour Swing strategies.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
