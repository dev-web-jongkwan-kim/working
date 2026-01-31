'use client';

import { useState, useEffect } from 'react';
import { CalendarResponse, getCalendarData } from '@/lib/api/manual-trading';
import { format, startOfMonth, getDay } from 'date-fns';
import { ko } from 'date-fns/locale';

interface TradingCalendarProps {
  initialData?: CalendarResponse;
  refreshTrigger?: number;
}

export function TradingCalendar({ initialData, refreshTrigger }: TradingCalendarProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [calendarData, setCalendarData] = useState<CalendarResponse | null>(initialData || null);
  const [loading, setLoading] = useState(false);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1;

  useEffect(() => {
    fetchCalendarData();
  }, [year, month, refreshTrigger]);

  const fetchCalendarData = async () => {
    setLoading(true);
    try {
      const data = await getCalendarData(year, month);
      setCalendarData(data);
    } catch (error) {
      console.error('Failed to fetch calendar data:', error);
    } finally {
      setLoading(false);
    }
  };

  const goToPrevMonth = () => {
    setCurrentDate(new Date(year, month - 2, 1));
  };

  const goToNextMonth = () => {
    setCurrentDate(new Date(year, month, 1));
  };

  const goToCurrentMonth = () => {
    setCurrentDate(new Date());
  };

  // 해당 월의 시작 요일 (0: 일요일, 1: 월요일 ...)
  const firstDayOfMonth = getDay(startOfMonth(new Date(year, month - 1)));
  const daysInMonth = calendarData?.calendar.length || 0;

  const weekDays = ['일', '월', '화', '수', '목', '금', '토'];

  return (
    <div className="trading-card p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          트레이딩 캘린더
        </h2>

        <div className="flex items-center gap-2">
          <button
            onClick={goToPrevMonth}
            className="p-2 rounded-lg hover:bg-background/80 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <button
            onClick={goToCurrentMonth}
            className="px-4 py-2 text-lg font-semibold rounded-lg hover:bg-background/80 transition-colors min-w-[160px]"
          >
            {format(currentDate, 'yyyy년 M월', { locale: ko })}
          </button>

          <button
            onClick={goToNextMonth}
            className="p-2 rounded-lg hover:bg-background/80 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {/* 월별 요약 */}
      {calendarData && (
        <div className="grid grid-cols-4 md:grid-cols-7 gap-4 mb-6 p-6 rounded-lg bg-background/50">
          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">거래일</div>
            <div className="text-2xl font-bold">{calendarData.summary.profitDays + calendarData.summary.lossDays}일</div>
          </div>
          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">거래횟수</div>
            <div className="text-2xl font-bold">{calendarData.summary.totalTrades}</div>
          </div>
          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">승률</div>
            <div className={`text-2xl font-bold ${calendarData.summary.winRate >= 50 ? 'profit-positive' : 'profit-negative'}`}>
              {calendarData.summary.winRate.toFixed(1)}%
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm text-muted-foreground mb-1">수익금</div>
            <div className={`text-2xl font-bold ${calendarData.summary.totalPnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
              {calendarData.summary.totalPnl >= 0 ? '+' : ''}${calendarData.summary.totalPnl.toFixed(2)}
            </div>
          </div>
          <div className="text-center hidden md:block">
            <div className="text-sm text-muted-foreground mb-1">수익일</div>
            <div className="text-2xl font-bold profit-positive">{calendarData.summary.profitDays}일</div>
          </div>
          <div className="text-center hidden md:block">
            <div className="text-sm text-muted-foreground mb-1">손실일</div>
            <div className="text-2xl font-bold profit-negative">{calendarData.summary.lossDays}일</div>
          </div>
          <div className="text-center hidden md:block">
            <div className="text-sm text-muted-foreground mb-1">승/패</div>
            <div className="text-2xl font-bold">
              <span className="profit-positive">{calendarData.summary.winningTrades}</span>
              {' / '}
              <span className="profit-negative">{calendarData.summary.losingTrades}</span>
            </div>
          </div>
        </div>
      )}

      {/* 요일 헤더 */}
      <div className="grid grid-cols-7 gap-2 mb-2">
        {weekDays.map((day, index) => (
          <div
            key={day}
            className={`text-center text-sm font-medium py-2 ${
              index === 0 ? 'text-red-400' : index === 6 ? 'text-blue-400' : 'text-muted-foreground'
            }`}
          >
            {day}
          </div>
        ))}
      </div>

      {/* 캘린더 그리드 */}
      {loading ? (
        <div className="flex items-center justify-center h-96">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-2">
          {/* 빈 셀 (월 시작 전) */}
          {Array.from({ length: firstDayOfMonth }).map((_, index) => (
            <div key={`empty-${index}`} className="aspect-square" />
          ))}

          {/* 날짜 셀 */}
          {calendarData?.calendar.map((day) => {
            const isToday =
              day.day === new Date().getDate() &&
              month === new Date().getMonth() + 1 &&
              year === new Date().getFullYear();
            const dayOfWeek = (firstDayOfMonth + day.day - 1) % 7;
            const isSunday = dayOfWeek === 0;
            const isSaturday = dayOfWeek === 6;

            return (
              <div
                key={day.day}
                className={`
                  aspect-square p-2 rounded-lg border transition-all
                  ${day.isProfit ? 'bg-green-500/20 border-green-500/40 hover:bg-green-500/30' : ''}
                  ${day.isLoss ? 'bg-red-500/20 border-red-500/40 hover:bg-red-500/30' : ''}
                  ${!day.isProfit && !day.isLoss ? 'bg-background/30 border-border/50 hover:bg-background/50' : ''}
                  ${isToday ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}
                `}
              >
                <div className="h-full flex flex-col">
                  {/* 날짜 */}
                  <div
                    className={`text-base font-semibold mb-1 ${
                      isSunday ? 'text-red-400' : isSaturday ? 'text-blue-400' : ''
                    }`}
                  >
                    {day.day}
                  </div>

                  {/* 거래 정보 */}
                  {day.totalTrades > 0 && (
                    <div className="flex-1 flex flex-col justify-center text-sm">
                      <div className={`text-base font-bold ${day.pnl >= 0 ? 'profit-positive' : 'profit-negative'}`}>
                        {day.pnl >= 0 ? '+' : ''}${day.pnl.toFixed(1)}
                      </div>
                      <div className="text-muted-foreground">
                        {day.totalTrades}건
                      </div>
                      <div className={`font-medium ${day.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                        {day.winRate.toFixed(0)}%
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 범례 */}
      <div className="flex items-center justify-center gap-6 mt-6 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-green-500/30 border border-green-500/50"></div>
          <span className="text-muted-foreground">수익</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-red-500/30 border border-red-500/50"></div>
          <span className="text-muted-foreground">손실</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-background/30 border border-border/50"></div>
          <span className="text-muted-foreground">거래 없음</span>
        </div>
      </div>
    </div>
  );
}
