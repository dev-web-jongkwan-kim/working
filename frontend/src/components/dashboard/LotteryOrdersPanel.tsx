'use client';

import { useState, useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { LotteryOrder } from '@/lib/api/lottery';
import { formatDistanceToNow } from 'date-fns';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

export function LotteryOrdersPanel({ initialOrders }: { initialOrders: LotteryOrder[] }) {
  const [orders, setOrders] = useState<LotteryOrder[]>(initialOrders);
  const [isOpen, setIsOpen] = useState(true); // Default: expanded
  const { subscribe, unsubscribe } = useWebSocket();

  useEffect(() => {
    const handleNewOrder = (data: any) => {
      // Add new order to the list
      const newOrder: LotteryOrder = {
        id: data.orderId,
        order_id: data.orderId,
        symbol: data.symbol,
        entry_price: data.entryPrice,
        depth_from_current: 0,
        lottery_score: data.lotteryScore,
        status: data.status,
        margin: data.margin,
        quantity: 0,
        leverage: data.leverage,
        stop_loss_price: data.stopLossPrice,
        binance_order_id: 0,
        entry_reason: '',
        expires_at: '',
        created_at: new Date().toISOString(),
      };
      setOrders((prev) => [newOrder, ...prev]);
    };

    const handleOrderUpdate = (data: any) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.order_id === data.orderId
            ? {
                ...o,
                status: data.status,
                filled_at: data.filledAt,
                pnl: data.pnl,
                pnl_pct: data.pnlPct,
              }
            : o
        )
      );
    };

    const handleOrderFilled = (data: any) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.order_id === data.orderId
            ? {
                ...o,
                status: 'FILLED',
                filled_at: data.filledAt,
              }
            : o
        )
      );
    };

    const handleOrderClosed = (data: any) => {
      setOrders((prev) =>
        prev.map((o) =>
          o.order_id === data.orderId
            ? {
                ...o,
                status: 'CLOSED',
                pnl: data.pnl,
                pnl_pct: data.pnlPct,
              }
            : o
        )
      );
    };

    subscribe('lottery:new', handleNewOrder);
    subscribe('lottery:update', handleOrderUpdate);
    subscribe('lottery:filled', handleOrderFilled);
    subscribe('lottery:closed', handleOrderClosed);

    return () => {
      unsubscribe('lottery:new', handleNewOrder);
      unsubscribe('lottery:update', handleOrderUpdate);
      unsubscribe('lottery:filled', handleOrderFilled);
      unsubscribe('lottery:closed', handleOrderClosed);
    };
  }, [subscribe, unsubscribe]);

  // Filter active orders (PENDING or FILLED)
  const activeOrders = orders.filter((o) => o.status === 'PENDING' || o.status === 'FILLED');

  if (activeOrders.length === 0) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className="text-2xl">🎰</span>
            Lottery Orders (0)
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
            <p className="text-muted-foreground">No active lottery orders</p>
            <p className="text-sm text-muted-foreground mt-1">Flash crash hunting orders will appear here</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <span className="text-2xl">🎰</span>
          Lottery Orders ({activeOrders.length}/3)
        </h2>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted-foreground">
            Flash Crash Hunting
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
              <th>Status</th>
              <th className="text-right">Entry Price</th>
              <th className="text-right">Stop Loss</th>
              <th className="text-right">Depth</th>
              <th className="text-right">Score</th>
              <th className="text-right">Leverage</th>
              <th className="text-right">Margin</th>
              <th className="text-right">P&L</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {activeOrders.map((order) => {
              const pnl = order.pnl || 0;
              const pnlPct = order.pnl_pct || 0;
              const pnlColor = pnl >= 0 ? 'profit-positive' : 'profit-negative';

              const statusColor = order.status === 'PENDING'
                ? 'bg-yellow-500/10 text-yellow-500'
                : order.status === 'FILLED'
                ? 'bg-green-500/10 text-green-500'
                : 'bg-gray-500/10 text-gray-500';

              return (
                <tr key={order.id}>
                  <td className="font-semibold">{order.symbol}</td>

                  <td>
                    <span className={`status-badge ${statusColor}`}>
                      {order.status}
                    </span>
                  </td>

                  <td className="text-right font-mono">
                    ${Number(order.entry_price).toFixed(6)}
                  </td>

                  <td className="text-right font-mono text-sm text-muted-foreground">
                    ${Number(order.stop_loss_price).toFixed(6)}
                  </td>

                  <td className="text-right">
                    <span className="status-badge bg-blue-500/10 text-blue-500">
                      -{Number(order.depth_from_current).toFixed(1)}%
                    </span>
                  </td>

                  <td className="text-right">
                    <span className="status-badge bg-purple-500/10 text-purple-500">
                      {order.lottery_score}
                    </span>
                  </td>

                  <td className="text-right">
                    <span className="status-badge bg-muted">
                      {order.leverage}x
                    </span>
                  </td>

                  <td className="text-right font-mono">
                    ${Number(order.margin).toFixed(2)}
                  </td>

                  <td className={`text-right font-bold font-mono ${pnlColor}`}>
                    {order.status === 'FILLED' ? (
                      <>
                        {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                        <div className="text-xs">
                          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>

                  <td className="text-sm text-muted-foreground">
                    {formatDistanceToNow(new Date(order.created_at), { addSuffix: true })}
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
              ${activeOrders.reduce((sum, o) => sum + Number(o.margin || 0), 0).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Pending</div>
            <div className="text-lg font-bold">
              {activeOrders.filter((o) => o.status === 'PENDING').length}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground mb-1">Filled</div>
            <div className="text-lg font-bold text-green-500">
              {activeOrders.filter((o) => o.status === 'FILLED').length}
            </div>
          </div>
        </div>
      </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
