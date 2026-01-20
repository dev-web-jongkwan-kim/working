'use client';

import { useState } from 'react';
import { Trade } from '@/lib/api/trades';
import { formatDistanceToNow } from 'date-fns';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

export function ClosedTradesPanel({ trades }: { trades: Trade[] }) {
  const [isOpen, setIsOpen] = useState(false); // Default: collapsed

  if (trades.length === 0) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-gray-500"></span>
            Closed Trades (0)
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-muted-foreground">No closed trades</p>
            <p className="text-sm text-muted-foreground mt-1">Trade history will appear here</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // Calculate summary stats
  const totalPnl = trades.reduce((sum, t) => sum + Number(t.pnl_usd || 0), 0);
  const winningTrades = trades.filter((t) => Number(t.pnl_usd || 0) > 0).length;
  const losingTrades = trades.filter((t) => Number(t.pnl_usd || 0) < 0).length;
  const winRate = trades.length > 0 ? (winningTrades / trades.length) * 100 : 0;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-gray-500"></span>
          Closed Trades ({trades.length})
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Win:</span>
              <span className="font-semibold profit-positive">{winningTrades}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Loss:</span>
              <span className="font-semibold profit-negative">{losingTrades}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Rate:</span>
              <span className={`font-semibold ${winRate >= 50 ? 'profit-positive' : 'profit-negative'}`}>
                {winRate.toFixed(1)}%
              </span>
            </div>
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
              <th className="text-right">Exit</th>
              <th className="text-right">Leverage</th>
              <th className="text-right">Margin</th>
              <th className="text-right">P&L %</th>
              <th className="text-right">P&L USD</th>
              <th>Duration</th>
              <th>Close Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((trade) => {
              const pnlUsd = Number(trade.pnl_usd || 0);
              const pnlPercent = Number(trade.pnl_percent || 0);
              const entryPrice = Number(trade.entry_price || 0);
              const exitPrice = trade.exit_price ? Number(trade.exit_price) : null;
              const marginUsd = Number(trade.margin_usd || 0);

              const pnlColor = pnlUsd >= 0 ? 'profit-positive' : 'profit-negative';
              const directionColor = trade.direction === 'LONG' ? 'direction-long' : 'direction-short';

              // Calculate duration
              const duration = trade.exit_time
                ? Math.round((new Date(trade.exit_time).getTime() - new Date(trade.entry_time).getTime()) / 1000 / 60)
                : 0;

              return (
                <tr key={trade.id}>
                  <td className="font-semibold">{trade.symbol}</td>

                  <td>
                    <div className="text-xs">
                      <div className="font-medium">{trade.strategy_type}</div>
                      <div className="text-muted-foreground">{trade.sub_strategy}</div>
                    </div>
                  </td>

                  <td>
                    <span className={`status-badge ${directionColor} ${trade.direction === 'LONG' ? 'bg-blue-500/10' : 'bg-orange-500/10'}`}>
                      {trade.direction}
                    </span>
                  </td>

                  <td className="text-right font-mono">
                    ${entryPrice.toFixed(6)}
                  </td>

                  <td className="text-right font-mono">
                    {exitPrice ? `$${exitPrice.toFixed(6)}` : '-'}
                  </td>

                  <td className="text-right">
                    <span className="status-badge bg-muted">
                      {trade.leverage}x
                    </span>
                  </td>

                  <td className="text-right font-mono">
                    ${marginUsd.toFixed(2)}
                  </td>

                  <td className={`text-right font-bold font-mono ${pnlColor}`}>
                    {pnlPercent >= 0 ? '+' : ''}
                    {pnlPercent.toFixed(2)}%
                  </td>

                  <td className={`text-right font-bold font-mono text-lg ${pnlColor}`}>
                    {pnlUsd >= 0 ? '+' : ''}
                    ${pnlUsd.toFixed(2)}
                  </td>

                  <td className="text-sm text-muted-foreground">
                    {duration < 60 ? `${duration}m` : `${Math.floor(duration / 60)}h ${duration % 60}m`}
                  </td>

                  <td>
                    <span className="text-xs text-muted-foreground capitalize">
                      {trade.close_reason?.replace(/_/g, ' ').toLowerCase() || 'Manual'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Summary */}
      <div className="mt-4 pt-4 border-t border-border">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Total Trades</div>
            <div className="text-lg font-bold">{trades.length}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Total P&L</div>
            <div className={`text-lg font-bold font-mono ${totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
              {totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Win Rate</div>
            <div className={`text-lg font-bold ${winRate >= 50 ? 'profit-positive' : 'profit-negative'}`}>
              {winRate.toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Avg P&L</div>
            <div className={`text-lg font-bold font-mono ${totalPnl / trades.length >= 0 ? 'profit-positive' : 'profit-negative'}`}>
              {totalPnl / trades.length >= 0 ? '+' : ''}${(totalPnl / trades.length).toFixed(2)}
            </div>
          </div>
        </div>
      </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
