#!/bin/bash

# 밤샘 모니터링 스크립트
# 5분마다 로그 체크, 심각한 에러 발생 시 서버 자동 종료

LOG_FILE="/Users/jongkwankim/my-work/working/backend/logs/trading-$(date +%Y-%m-%d).log"
MONITOR_LOG="/tmp/monitor-$(date +%Y-%m-%d).log"
ERROR_COUNT_THRESHOLD=10  # 5분 내 에러 10개 이상이면 종료
CRITICAL_ERRORS=("CRITICAL|Redis Client Error|Database.*failed|WebSocket.*failed|Failed to connect|Emergency close")

echo "=== 모니터링 시작: $(date) ===" | tee -a "$MONITOR_LOG"

while true; do
    TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

    # 최근 5분 로그 추출 (300초 = 5분)
    RECENT_LOGS=$(tail -500 "$LOG_FILE" 2>/dev/null)

    # 심각한 에러 카운트
    ERROR_COUNT=0
    for pattern in "${CRITICAL_ERRORS[@]}"; do
        COUNT=$(echo "$RECENT_LOGS" | grep -iE "$pattern" | wc -l | tr -d ' ')
        ERROR_COUNT=$((ERROR_COUNT + COUNT))
    done

    # 에러가 임계값 초과 시
    if [ "$ERROR_COUNT" -ge "$ERROR_COUNT_THRESHOLD" ]; then
        echo "[$TIMESTAMP] 🚨 CRITICAL: $ERROR_COUNT 개의 심각한 에러 감지! 서버 종료 중..." | tee -a "$MONITOR_LOG"

        # 에러 상세 로그 저장
        echo "=== 에러 상세 ===" >> "$MONITOR_LOG"
        echo "$RECENT_LOGS" | grep -iE "error|critical|fail" | tail -20 >> "$MONITOR_LOG"

        # 백엔드 종료
        pkill -f "npm run start:dev"
        pkill -f "nest start"

        echo "[$TIMESTAMP] ✅ 서버 종료 완료" | tee -a "$MONITOR_LOG"
        exit 1
    fi

    # 정상 상태 체크
    PROCESS_COUNT=$(ps aux | grep -E "nest start" | grep -v grep | wc -l | tr -d ' ')

    if [ "$PROCESS_COUNT" -eq 0 ]; then
        echo "[$TIMESTAMP] ⚠️  백엔드 프로세스가 종료됨!" | tee -a "$MONITOR_LOG"
        exit 1
    fi

    # 활성 포지션 확인
    ACTIVE_POSITIONS=$(curl -s http://localhost:3001/api/positions/active 2>/dev/null | jq 'length' 2>/dev/null || echo "0")

    # 최근 시그널 확인 (15분봉/1시간봉 마감 시)
    MINUTE=$(date +%M)
    if [[ "$MINUTE" == "00" || "$MINUTE" == "15" || "$MINUTE" == "30" || "$MINUTE" == "45" ]]; then
        RECENT_SIGNALS=$(echo "$RECENT_LOGS" | grep -E "✅ Signal generated|Order pending" | tail -3)
        if [ -n "$RECENT_SIGNALS" ]; then
            echo "[$TIMESTAMP] 📊 최근 시그널:" | tee -a "$MONITOR_LOG"
            echo "$RECENT_SIGNALS" | tee -a "$MONITOR_LOG"
        fi
    fi

    # 정상 상태 로그 (5분마다)
    echo "[$TIMESTAMP] ✅ 정상 - 활성 포지션: $ACTIVE_POSITIONS, 에러: $ERROR_COUNT" | tee -a "$MONITOR_LOG"

    # 5분 대기
    sleep 300
done
