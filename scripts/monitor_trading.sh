#!/bin/bash

# Trading System Real-time Monitor
# Usage: ./monitor_trading.sh

BACKEND_URL="http://localhost:3031"
PGPASSWORD="trading_password"
export PGPASSWORD

clear

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║          TRADING SYSTEM REAL-TIME MONITOR                      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

while true; do
    # Get current time
    NOW=$(date '+%Y-%m-%d %H:%M:%S')

    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🕐 $NOW"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # System Status
    echo ""
    echo "📊 SYSTEM STATUS"
    echo "────────────────────────────────────────────────────────────────"
    curl -s $BACKEND_URL/dual-strategy/status | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f\"Status: {'🟢 RUNNING' if d['isRunning'] else '🔴 STOPPED'}\")
    print(f\"Active Positions: {d['activePositions']}\")
    print(f\"Market Regime: {d['currentRegime']['regime']}\")
    print(f\"Volatility: {d['currentRegime']['volatility']:.4f}\")
except:
    print('❌ API Error')
"

    # Today's Statistics
    echo ""
    echo "📈 TODAY'S STATISTICS"
    echo "────────────────────────────────────────────────────────────────"
    psql -h localhost -U trading_user -d trading_system -t -c "
    SELECT
        '🎯 Signals: ' || COUNT(*) ||
        ' (Executed: ' || SUM(CASE WHEN executed THEN 1 ELSE 0 END) || ')'
    FROM signals WHERE DATE(created_at) = CURRENT_DATE;

    SELECT
        '💼 Positions: ' || COUNT(*) ||
        ' (Active: ' || SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) ||
        ', Closed: ' || SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) || ')'
    FROM positions WHERE DATE(created_at) = CURRENT_DATE;

    SELECT
        '💰 Total PNL: ' || COALESCE(ROUND(SUM(pnl_usd)::numeric, 2), 0) || ' USDT ' ||
        '(Avg: ' || COALESCE(ROUND(AVG(pnl_percent)::numeric, 2), 0) || '%)'
    FROM trades WHERE DATE(entry_time) = CURRENT_DATE AND status = 'CLOSED';
    "

    # Active Positions
    echo ""
    echo "🔥 ACTIVE POSITIONS"
    echo "────────────────────────────────────────────────────────────────"
    psql -h localhost -U trading_user -d trading_system -t -c "
    SELECT
        RPAD(symbol, 12) || ' ' ||
        RPAD(strategy_type::text, 12) || ' ' ||
        RPAD(direction::text, 6) || ' ' ||
        'PNL: ' || LPAD(ROUND(unrealized_pnl_percent::numeric, 2)::text || '%', 8) ||
        ' (' || ROUND(unrealized_pnl::numeric, 2) || ' USDT)'
    FROM positions
    WHERE status = 'ACTIVE'
    ORDER BY unrealized_pnl_percent DESC;
    " | head -10

    ACTIVE_COUNT=$(psql -h localhost -U trading_user -d trading_system -t -c "SELECT COUNT(*) FROM positions WHERE status = 'ACTIVE';" | tr -d ' ')
    if [ "$ACTIVE_COUNT" -eq "0" ]; then
        echo "   No active positions"
    fi

    # Recent Signals (Last 5)
    echo ""
    echo "⚡ RECENT SIGNALS (Last 5)"
    echo "────────────────────────────────────────────────────────────────"
    psql -h localhost -U trading_user -d trading_system -t -c "
    SELECT
        TO_CHAR(created_at, 'HH24:MI:SS') || ' ' ||
        RPAD(symbol, 12) || ' ' ||
        RPAD(strategy_type::text, 12) || ' ' ||
        RPAD(direction::text, 6) || ' ' ||
        'Conf: ' || confidence || '%'
    FROM signals
    WHERE DATE(created_at) = CURRENT_DATE
    ORDER BY created_at DESC
    LIMIT 5;
    " | head -5

    SIGNAL_COUNT=$(psql -h localhost -U trading_user -d trading_system -t -c "SELECT COUNT(*) FROM signals WHERE DATE(created_at) = CURRENT_DATE;" | tr -d ' ')
    if [ "$SIGNAL_COUNT" -eq "0" ]; then
        echo "   No signals today"
    fi

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔄 Refreshing in 10 seconds... (Ctrl+C to stop)"
    echo ""

    sleep 10
    clear
done
