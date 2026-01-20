'use client';

import { useState } from 'react';
import { DailyStats, Trade } from '@/lib/api/trades';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

interface DailyTradesPanelProps {
  dailyData: DailyStats;
}

export function DailyTradesPanel({ dailyData }: DailyTradesPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const pnlColor = dailyData.totalPnl >= 0 ? 'profit-positive' : 'profit-negative';
  const winRateColor = dailyData.winRate >= 50 ? 'profit-positive' : 'profit-negative';

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="border border-border rounded-lg overflow-hidden">
      <CollapsibleTrigger asChild>
        <div className="flex items-center justify-between p-4 bg-card hover:bg-muted/50 cursor-pointer transition-colors">
          <div className="flex items-center gap-4">
            <ChevronDown
              className={`h-5 w-5 transition-transform ${
                isOpen ? 'transform rotate-180' : ''
              }`}
            />
            <div>
              <div className="font-semibold">{formatDate(dailyData.date)}</div>
              <div className="text-sm text-muted-foreground">
                {dailyData.totalTrades} trade{dailyData.totalTrades !== 1 ? 's' : ''}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6">
            {/* Win/Loss/Rate */}
            <div className="flex gap-4 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Win:</span>
                <span className="font-semibold profit-positive">{dailyData.winningTrades}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Loss:</span>
                <span className="font-semibold profit-negative">{dailyData.losingTrades}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Rate:</span>
                <span className={`font-semibold ${winRateColor}`}>
                  {dailyData.winRate.toFixed(1)}%
                </span>
              </div>
            </div>

            {/* Total P&L */}
            <div className="text-right min-w-[120px]">
              <div className={`text-lg font-bold font-mono ${pnlColor}`}>
                {dailyData.totalPnl >= 0 ? '+' : ''}${dailyData.totalPnl.toFixed(2)}
              </div>
              <div className={`text-xs ${pnlColor}`}>
                {dailyData.totalPnlPercent >= 0 ? '+' : ''}{dailyData.totalPnlPercent.toFixed(2)}%
              </div>
            </div>
          </div>
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="border-t border-border">
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
                {dailyData.trades.map((trade) => {
                  const pnlUsd = Number(trade.pnl_usd || 0);
                  const pnlPercent = Number(trade.pnl_percent || 0);
                  const entryPrice = Number(trade.entry_price || 0);
                  const exitPrice = trade.exit_price ? Number(trade.exit_price) : null;
                  const marginUsd = Number(trade.margin_usd || 0);

                  const tradePnlColor = pnlUsd >= 0 ? 'profit-positive' : 'profit-negative';
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

                      <td className={`text-right font-bold font-mono ${tradePnlColor}`}>
                        {pnlPercent >= 0 ? '+' : ''}
                        {pnlPercent.toFixed(2)}%
                      </td>

                      <td className={`text-right font-bold font-mono text-lg ${tradePnlColor}`}>
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
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
