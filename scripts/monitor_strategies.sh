#!/bin/bash

# Strategy Monitoring Script
# Runs every 15 minutes until 09:00 KST
# Collects filter statistics for each strategy

LOG_DIR="/Users/jongkwankim/my-work/working/scripts/monitoring_logs"
REPORT_FILE="$LOG_DIR/strategy_report_$(date +%Y%m%d).md"
mkdir -p "$LOG_DIR"

# Initialize report
echo "# 전략 필터링 모니터링 리포트" > "$REPORT_FILE"
echo "모니터링 시작: $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"

collect_stats() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    local interval_file="$LOG_DIR/interval_$(date +%H%M).log"

    echo "=== $timestamp ===" >> "$interval_file"

    # Get last 15 minutes of logs
    docker logs trading-backend --since 15m 2>&1 > /tmp/recent_logs.txt

    # Count ATR filters
    local atr_too_high=$(grep -c "ATR too high" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local atr_too_low=$(grep -c "ATR too low" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local atr_ok=$(grep -c "ATR OK" /tmp/recent_logs.txt 2>/dev/null || echo 0)

    # Count regime filters
    local regime_blocked=$(grep -c "REGIME FILTER" /tmp/recent_logs.txt 2>/dev/null || echo 0)

    # Count by strategy
    local cycle_rider_signals=$(grep -c "\[CycleRider\].*Signal\|EVENT-DRIVEN Cycle Rider" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local hour_swing_signals=$(grep -c "\[HourSwing\].*Signal\|EVENT-DRIVEN Hour Swing" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local box_range_signals=$(grep -c "\[BoxRange\].*Signal\|Box Range" /tmp/recent_logs.txt 2>/dev/null || echo 0)

    # Count specific filter reasons
    local consecutive_bars=$(grep -c "consecutive.*bars\|maxConsecutive" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local trend_strength=$(grep -c "trend.*strength\|minStrength\|maxStrength" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local cooldown=$(grep -c "cooldown" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local no_signal=$(grep -c "No signal" /tmp/recent_logs.txt 2>/dev/null || echo 0)

    # Get market regime
    local regime=$(grep "Market regime" /tmp/recent_logs.txt | tail -1 | grep -oE "STRONG_DOWNTREND|STRONG_UPTREND|DOWNTREND|UPTREND|SIDEWAYS" || echo "UNKNOWN")

    # Get positions
    local active_positions=$(grep "Monitoring.*active positions" /tmp/recent_logs.txt | tail -1 | grep -oE "[0-9]+ active" || echo "0 active")

    # Get Daily PnL
    local daily_pnl=$(grep "Daily P&L check" /tmp/recent_logs.txt | tail -1 | grep -oE "Total=[0-9.-]+" | cut -d= -f2 || echo "N/A")

    # Count order executions
    local orders_filled=$(grep -c "FILLED" /tmp/recent_logs.txt 2>/dev/null || echo 0)
    local orders_rejected=$(grep -c "rejected\|REJECTED" /tmp/recent_logs.txt 2>/dev/null || echo 0)

    # Specific symbols filtered
    local filtered_symbols=$(grep -E "❌ ATR too|REGIME FILTER" /tmp/recent_logs.txt | grep -oE "[A-Z]+USDT" | sort | uniq -c | sort -rn | head -10)

    # Write to interval file
    cat >> "$interval_file" << STATS
Timestamp: $timestamp
Market Regime: $regime
Active Positions: $active_positions
Daily PnL: \$$daily_pnl

=== ATR Filter ===
- Passed (OK): $atr_ok
- Blocked (Too High): $atr_too_high
- Blocked (Too Low): $atr_too_low

=== Regime Filter ===
- Blocked: $regime_blocked

=== Other Filters ===
- Consecutive Bars: $consecutive_bars
- Trend Strength: $trend_strength
- Cooldown: $cooldown
- No Signal: $no_signal

=== Strategy Activity ===
- Cycle Rider Signals: $cycle_rider_signals
- Hour Swing Signals: $hour_swing_signals
- Box Range Signals: $box_range_signals

=== Orders ===
- Filled: $orders_filled
- Rejected: $orders_rejected

=== Top Filtered Symbols ===
$filtered_symbols

STATS

    # Append summary to main report
    echo "" >> "$REPORT_FILE"
    echo "## $timestamp" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "| 항목 | 값 |" >> "$REPORT_FILE"
    echo "|------|-----|" >> "$REPORT_FILE"
    echo "| Market Regime | $regime |" >> "$REPORT_FILE"
    echo "| Active Positions | $active_positions |" >> "$REPORT_FILE"
    echo "| Daily PnL | \$$daily_pnl |" >> "$REPORT_FILE"
    echo "| ATR OK | $atr_ok |" >> "$REPORT_FILE"
    echo "| ATR Too High | $atr_too_high |" >> "$REPORT_FILE"
    echo "| ATR Too Low | $atr_too_low |" >> "$REPORT_FILE"
    echo "| Regime Blocked | $regime_blocked |" >> "$REPORT_FILE"
    echo "| Orders Filled | $orders_filled |" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"

    echo "[$timestamp] Collected stats - ATR OK:$atr_ok, High:$atr_too_high, Low:$atr_too_low, Regime:$regime"
}

# Main loop - run until 09:00
while true; do
    current_hour=$(date +%H)
    current_min=$(date +%M)

    # Check if it's 9:00 AM or later
    if [ "$current_hour" -ge 9 ] && [ "$current_hour" -lt 10 ]; then
        echo "=== Final Report at 09:00 ===" >> "$REPORT_FILE"
        echo "모니터링 종료: $(date '+%Y-%m-%d %H:%M:%S KST')" >> "$REPORT_FILE"
        echo "Monitoring complete. Report saved to $REPORT_FILE"
        break
    fi

    # Collect stats
    collect_stats

    # Wait 15 minutes
    echo "Next collection in 15 minutes..."
    sleep 900
done
