'use client';

import { useState, useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Position } from '@/lib/api/trades';
import { formatDistanceToNow } from 'date-fns';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

export function ActiveTradesPanel({ initialPositions }: { initialPositions: Position[] }) {
  const [positions, setPositions] = useState<Position[]>(initialPositions);
  const [isOpen, setIsOpen] = useState(false); // Default: collapsed
  const { subscribe, unsubscribe } = useWebSocket();

  useEffect(() => {
    const handlePositionUpdate = (data: any) => {
      setPositions((prev) =>
        prev.map((p) =>
          p.position_id === data.positionId
            ? {
                ...p,
                current_price: data.currentPrice,
                unrealized_pnl: data.unrealizedPnl,
                unrealized_pnl_percent: data.unrealizedPnlPercent,
              }
            : p
        )
      );
    };

    const handlePositionClosed = (data: any) => {
      setPositions((prev) => prev.filter((p) => p.position_id !== data.positionId));
    };

    subscribe('position:update', handlePositionUpdate);
    subscribe('position:closed', handlePositionClosed);

    return () => {
      unsubscribe('position:update', handlePositionUpdate);
      unsubscribe('position:closed', handlePositionClosed);
    };
  }, [subscribe, unsubscribe]);

  if (positions.length === 0) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500"></span>
            Active Positions (0)
          </h2>
          <CollapsibleTrigger asChild>
            <button className="p-2 hover:bg-muted rounded-md transition-colors">
              <ChevronDown
                className={`h-5 w-5 transition-transform ${
                  isOpen ? 'transform rotate-180' : ''
                }`}
              />
            </button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <div className="text-center py-12">
            <svg className="w-16 h-16 mx-auto text-muted-foreground/50 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p className="text-muted-foreground">No active positions</p>
            <p className="text-sm text-muted-foreground mt-1">Positions will appear here when trades are opened</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
          Active Positions ({positions.length})
        </h2>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
            Live Updates
          </div>
          <CollapsibleTrigger asChild>
            <button className="p-2 hover:bg-muted rounded-md transition-colors">
              <ChevronDown
                className={`h-5 w-5 transition-transform ${
                  isOpen ? 'transform rotate-180' : ''
                }`}
              />
            </button>
          </CollapsibleTrigger>
        </div>
      </div>

      <CollapsibleContent>

      <div className="overflow-x-auto">
        <table className="trading-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Strategy</th>
              <th>Direction</th>
              <th className="text-right">Entry</th>
              <th className="text-right">Current</th>
              <th className="text-right">Leverage</th>
              <th className="text-right">Margin</th>
              <th className="text-right">P&L %</th>
              <th className="text-right">P&L USD</th>
              <th>Time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              const unrealizedPnl = Number(position.unrealized_pnl || 0);
              const unrealizedPnlPercent = Number(position.unrealized_pnl_percent || 0);
              const entryPrice = Number(position.entry_price || 0);
              const currentPrice = Number(position.current_price || 0);
              const marginUsd = Number(position.margin_usd || 0);

              const pnlColor = unrealizedPnl >= 0 ? 'profit-positive' : 'profit-negative';
              const directionColor = position.direction === 'LONG' ? 'direction-long' : 'direction-short';

              return (
                <tr key={position.id}>
                  <td className="font-semibold">{position.symbol}</td>

                  <td>
                    <div className="text-xs">
                      <div className="font-medium">{position.strategy_type}</div>
                      <div className="text-muted-foreground">{position.sub_strategy}</div>
                    </div>
                  </td>

                  <td>
                    <span className={`status-badge ${directionColor} ${position.direction === 'LONG' ? 'bg-blue-500/10' : 'bg-orange-500/10'}`}>
                      {position.direction}
                    </span>
                  </td>

                  <td className="text-right font-mono">
                    ${entryPrice.toFixed(6)}
                  </td>

                  <td className="text-right font-mono font-semibold">
                    ${currentPrice.toFixed(6)}
                  </td>

                  <td className="text-right">
                    <span className="status-badge bg-muted">
                      {position.leverage}x
                    </span>
                  </td>

                  <td className="text-right font-mono">
                    ${marginUsd.toFixed(2)}
                  </td>

                  <td className={`text-right font-bold font-mono ${pnlColor}`}>
                    {unrealizedPnlPercent >= 0 ? '+' : ''}
                    {unrealizedPnlPercent.toFixed(2)}%
                  </td>

                  <td className={`text-right font-bold font-mono text-lg ${pnlColor}`}>
                    {unrealizedPnl >= 0 ? '+' : ''}
                    ${unrealizedPnl.toFixed(2)}
                  </td>

                  <td className="text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(position.entry_time), { addSuffix: true })}
                  </td>

                  <td>
                    <div className="flex gap-1">
                      {position.tp1_filled && (
                        <span className="status-badge bg-green-500/10 text-green-500 text-xs">
                          TP1
                        </span>
                      )}
                      {position.tp2_filled && (
                        <span className="status-badge bg-green-500/10 text-green-500 text-xs">
                          TP2
                        </span>
                      )}
                      {!position.tp1_filled && !position.tp2_filled && (
                        <span className="status-badge bg-yellow-500/10 text-yellow-500 text-xs">
                          Open
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Summary */}
      <div className="mt-4 pt-4 border-t border-border">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Total Margin</div>
            <div className="text-lg font-bold font-mono">
              ${positions.reduce((sum, p) => sum + Number(p.margin_usd || 0), 0).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Total P&L</div>
            <div className={`text-lg font-bold font-mono ${
              positions.reduce((sum, p) => sum + Number(p.unrealized_pnl || 0), 0) >= 0
                ? 'profit-positive'
                : 'profit-negative'
            }`}>
              {positions.reduce((sum, p) => sum + Number(p.unrealized_pnl || 0), 0) >= 0 ? '+' : ''}
              ${positions.reduce((sum, p) => sum + Number(p.unrealized_pnl || 0), 0).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Avg P&L %</div>
            <div className={`text-lg font-bold font-mono ${
              (positions.reduce((sum, p) => sum + Number(p.unrealized_pnl_percent || 0), 0) / positions.length) >= 0
                ? 'profit-positive'
                : 'profit-negative'
            }`}>
              {(positions.reduce((sum, p) => sum + Number(p.unrealized_pnl_percent || 0), 0) / positions.length) >= 0 ? '+' : ''}
              {(positions.reduce((sum, p) => sum + Number(p.unrealized_pnl_percent || 0), 0) / positions.length).toFixed(2)}%
            </div>
          </div>
        </div>
      </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
