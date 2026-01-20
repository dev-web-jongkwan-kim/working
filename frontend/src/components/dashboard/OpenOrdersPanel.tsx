'use client';

import { useState, useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { OpenOrder } from '@/lib/api/trades';
import { formatDistanceToNow } from 'date-fns';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';

export function OpenOrdersPanel({ initialOrders }: { initialOrders: OpenOrder[] }) {
  const [orders, setOrders] = useState<OpenOrder[]>(initialOrders);
  const [isOpen, setIsOpen] = useState(true); // Default: expanded
  const { subscribe, unsubscribe } = useWebSocket();

  useEffect(() => {
    // Listen for order updates from WebSocket
    const handleOrderUpdate = (data: any) => {
      if (data.eventType === 'ORDER_TRADE_UPDATE') {
        const orderUpdate = data.order;

        // If order is filled or cancelled, remove from list
        if (['FILLED', 'CANCELED', 'EXPIRED'].includes(orderUpdate.orderStatus)) {
          setOrders((prev) => prev.filter((o) => o.orderId !== orderUpdate.orderId));
        } else if (orderUpdate.orderStatus === 'NEW') {
          // Add new order
          const newOrder: OpenOrder = {
            orderId: orderUpdate.orderId,
            symbol: orderUpdate.symbol,
            side: orderUpdate.side,
            type: orderUpdate.orderType,
            price: parseFloat(orderUpdate.price),
            stopPrice: parseFloat(orderUpdate.stopPrice || '0'),
            origQty: parseFloat(orderUpdate.originalQuantity),
            executedQty: parseFloat(orderUpdate.executedQuantity),
            status: orderUpdate.orderStatus,
            timeInForce: orderUpdate.timeInForce,
            reduceOnly: orderUpdate.isReduceOnly,
            closePosition: orderUpdate.closePosition,
            time: orderUpdate.orderTradeTime,
            updateTime: orderUpdate.orderTradeTime,
          };
          setOrders((prev) => [newOrder, ...prev]);
        } else {
          // Update existing order
          setOrders((prev) =>
            prev.map((o) =>
              o.orderId === orderUpdate.orderId
                ? {
                    ...o,
                    executedQty: parseFloat(orderUpdate.executedQuantity),
                    status: orderUpdate.orderStatus,
                    updateTime: orderUpdate.orderTradeTime,
                  }
                : o
            )
          );
        }
      }
    };

    subscribe('binance:orderUpdate', handleOrderUpdate);

    return () => {
      unsubscribe('binance:orderUpdate', handleOrderUpdate);
    };
  }, [subscribe, unsubscribe]);

  if (orders.length === 0) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
            Open Orders (0)
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
            <p className="text-muted-foreground">No open orders</p>
            <p className="text-sm text-muted-foreground mt-1">Pending limit orders and TP/SL orders will appear here</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // Separate entry orders and TP/SL orders
  const entryOrders = orders.filter((o) => !o.reduceOnly && !o.closePosition);
  const tpSlOrders = orders.filter((o) => o.reduceOnly || o.closePosition);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="trading-panel">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
          Open Orders ({orders.length})
        </h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Entry:</span>
              <span className="font-semibold">{entryOrders.length}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">TP/SL:</span>
              <span className="font-semibold">{tpSlOrders.length}</span>
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
                <th>Type</th>
                <th>Side</th>
                <th className="text-right">Price</th>
                <th className="text-right">Stop Price</th>
                <th className="text-right">Quantity</th>
                <th className="text-right">Filled</th>
                <th>Status</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => {
                const sideColor = order.side === 'BUY' ? 'direction-long bg-blue-500/10' : 'direction-short bg-orange-500/10';
                const typeLabel = order.reduceOnly || order.closePosition
                  ? (order.type.includes('STOP') ? 'SL' : 'TP')
                  : 'Entry';
                const typeColor = typeLabel === 'SL'
                  ? 'bg-red-500/10 text-red-500'
                  : typeLabel === 'TP'
                    ? 'bg-green-500/10 text-green-500'
                    : 'bg-blue-500/10 text-blue-500';

                return (
                  <tr key={order.orderId}>
                    <td className="font-semibold">{order.symbol}</td>

                    <td>
                      <div className="flex flex-col gap-1">
                        <span className={`status-badge ${typeColor}`}>
                          {typeLabel}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {order.type.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </td>

                    <td>
                      <span className={`status-badge ${sideColor}`}>
                        {order.side}
                      </span>
                    </td>

                    <td className="text-right font-mono">
                      {order.price > 0 ? `$${order.price.toFixed(6)}` : '-'}
                    </td>

                    <td className="text-right font-mono text-muted-foreground">
                      {order.stopPrice > 0 ? `$${order.stopPrice.toFixed(6)}` : '-'}
                    </td>

                    <td className="text-right font-mono">
                      {order.origQty.toFixed(4)}
                    </td>

                    <td className="text-right font-mono">
                      {order.executedQty > 0 ? (
                        <span className="text-green-500">
                          {order.executedQty.toFixed(4)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>

                    <td>
                      <span className="status-badge bg-yellow-500/10 text-yellow-500">
                        {order.status}
                      </span>
                    </td>

                    <td className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(order.time), { addSuffix: true })}
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
              <div className="text-xs text-muted-foreground mb-1">Total Orders</div>
              <div className="text-lg font-bold">{orders.length}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Entry Orders</div>
              <div className="text-lg font-bold text-blue-500">{entryOrders.length}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Take Profit</div>
              <div className="text-lg font-bold text-green-500">
                {tpSlOrders.filter((o) => !o.type.includes('STOP')).length}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Stop Loss</div>
              <div className="text-lg font-bold text-red-500">
                {tpSlOrders.filter((o) => o.type.includes('STOP')).length}
              </div>
            </div>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
