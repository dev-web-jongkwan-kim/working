'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  ComposedChart,
} from 'recharts';
import { EquityCurveResponse } from '@/lib/api/manual-trading';
import { format } from 'date-fns';
import { ko } from 'date-fns/locale';

interface EquityChartProps {
  data: EquityCurveResponse;
}

export function EquityChart({ data }: EquityChartProps) {
  const chartData = data.curve.map((point, index) => ({
    ...point,
    time: new Date(point.time).getTime(),
    formattedTime: format(new Date(point.time), 'MM/dd HH:mm', { locale: ko }),
    index,
  }));

  const minBalance = Math.min(...chartData.map((d) => d.balance), data.startingBalance);
  const maxBalance = Math.max(...chartData.map((d) => d.balance), data.startingBalance);
  const padding = (maxBalance - minBalance) * 0.1;

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const point = payload[0].payload;
      return (
        <div className="bg-card border border-border rounded-lg p-3 shadow-lg">
          <p className="text-sm text-muted-foreground mb-1">
            {format(new Date(point.time), 'yyyy-MM-dd HH:mm:ss', { locale: ko })}
          </p>
          <p className="text-sm font-medium mb-1">
            {point.symbol}
          </p>
          <p className={`text-sm font-bold ${point.pnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
            P&L: {point.pnl >= 0 ? '+' : ''}${point.pnl.toFixed(2)}
          </p>
          <p className="text-sm font-bold text-blue-400">
            잔액: ${point.balance.toFixed(2)}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="trading-card p-6">
      <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
        </svg>
        자본금 변동 (Equity Curve)
      </h2>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="text-center p-3 rounded-lg bg-background/50">
          <div className="text-xs text-muted-foreground mb-1">시작 잔액</div>
          <div className="text-lg font-bold">${data.startingBalance.toFixed(2)}</div>
        </div>
        <div className="text-center p-3 rounded-lg bg-background/50">
          <div className="text-xs text-muted-foreground mb-1">현재 잔액</div>
          <div className="text-lg font-bold text-blue-400">${data.currentBalance.toFixed(2)}</div>
        </div>
        <div className={`text-center p-3 rounded-lg ${data.totalPnl >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'}`}>
          <div className="text-xs text-muted-foreground mb-1">총 수익</div>
          <div className={`text-lg font-bold ${data.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
            {data.totalPnl >= 0 ? '+' : ''}${data.totalPnl.toFixed(2)}
          </div>
        </div>
      </div>

      {chartData.length === 0 ? (
        <div className="flex items-center justify-center h-80 text-muted-foreground">
          거래 데이터가 없습니다. 동기화 버튼을 눌러주세요.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
            <defs>
              <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="formattedTime"
              tick={{ fill: '#888', fontSize: 11 }}
              tickLine={{ stroke: '#444' }}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[minBalance - padding, maxBalance + padding]}
              tick={{ fill: '#888', fontSize: 11 }}
              tickLine={{ stroke: '#444' }}
              tickFormatter={(value) => `$${value.toFixed(0)}`}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine
              y={data.startingBalance}
              stroke="#666"
              strokeDasharray="5 5"
              label={{
                value: '시작 잔액',
                fill: '#888',
                fontSize: 11,
                position: 'right',
              }}
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="transparent"
              fill="url(#balanceGradient)"
            />
            <Line
              type="monotone"
              dataKey="balance"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={(props: any) => {
                const { cx, cy, payload } = props;
                const color = payload.pnl >= 0 ? '#22c55e' : '#ef4444';
                return (
                  <circle
                    key={`dot-${payload.index}`}
                    cx={cx}
                    cy={cy}
                    r={4}
                    fill={color}
                    stroke="#1f2937"
                    strokeWidth={2}
                  />
                );
              }}
              activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
