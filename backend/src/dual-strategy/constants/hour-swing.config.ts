/**
 * Strategy B: Hour Swing Configuration
 * Goal: Quick confirmed profits within 1 hour
 *
 * [개선 이력]
 * 2026-01-24: 5연패 원인 분석 후 대폭 개선
 *   - 레버리지: 12x → 10x (손실 축소)
 *   - SL 범위: 0.6%~1.5% → 0.8%~2.0% (조기 SL 방지)
 *   - Regime Filter: WEAK에서도 역방향 차단
 *   - 풀백 조건: 0.5~1.2 ATR → 0.6~1.0 ATR
 *   - CVD 확인: 3% → 5%
 * 2026-01-24 21:10: 6연패 후 마진 추가 축소
 *   - 마진: $25 → $15 (리스크 40% 감소)
 * 2026-01-24 (README 스펙 반영):
 *   - SIDEWAYS 레짐: Hour Swing 완전 OFF
 *   - Loss-streak Kill Switch: 3연패 → 60분 쿨다운
 */

export const HOUR_SWING_CONFIG = {
  // Position management
  position: {
    leverage: 10, // 개선: 12 → 10 (SL 히트 시 손실 축소)
    marginUsd: 15, // 개선: 30 → 25 → 15 (6연패 후 추가 축소)
    maxPositions: 3, // 개선: 5 → 3 (집중도 높임)
    maxSameDirection: 2, // 개선: 3 → 2
    minHoldMinutes: 10, // 개선: 15 → 10 (초반 SL 보호용)
    maxHoldMinutes: 60,
    tp1ClosePercent: 50,
    cooldownMinutes: 15, // 개선: 10 → 15 (연속 손실 방지)
  },

  // Breakeven
  breakeven: {
    enabled: true,
    activateAtRR: 1.0,
    moveSlToEntry: true,
  },

  // Time-based close
  timeBasedClose: {
    after45MinProfit: true,
    after60Min: true,
  },

  // Filters (NEW: ATR filter to prevent high-volatility entries)
  filters: {
    minAtrPercent: 0.005, // 0.5% minimum
    maxAtrPercent: 0.035, // 3.5% maximum (같은 기준 Cycle Rider 3%, Box Range 3.5%)
    atrPeriod: 14,
  },

  // Regime filter (개선: WEAK에서도 역방향 차단)
  regimeFilter: {
    enabled: true,
    // Block LONG during downtrend, SHORT during uptrend (WEAK 포함)
    blockCounterTrend: true,
    blockWeakCounterTrend: true, // 개선: WEAK_UPTREND에서 SHORT, WEAK_DOWNTREND에서 LONG 차단
    // Only allow trades in these regimes (empty = allow all)
    allowedRegimes: [], // Will filter in code
    // 2026-01-24: SIDEWAYS 완전 OFF (README 스펙 반영)
    sidewaysOff: true, // SIDEWAYS 레짐에서 Hour Swing 완전 비활성화
  },

  // 2026-01-24: Loss-streak Kill Switch (README 스펙 반영)
  // 연속 손절 발생 시 전략 일시 중단
  lossStreakKillSwitch: {
    enabled: true,
    maxConsecutiveLosses: 3, // 3번 연속 SL 히트 시
    cooldownMinutes: 60, // 60분 쿨다운
  },

  // Concurrent entry limit (NEW: prevent multiple entries at same time)
  concurrentEntryLimit: {
    enabled: true,
    maxEntriesWithinWindow: 2, // 최대 2개까지 동시 진입 허용
    windowMinutes: 5, // 5분 내 동시 진입 제한
  },

  // Sub-strategies
  subStrategies: {
    // 1. MTF Alignment + Pullback
    mtfAlignment: {
      enabled: true,
      h1: {
        trendBars: 6,
        minStrength: 0.07, // 최적화: 0.15 → 0.10 → 0.07 (보수적 완화, 99% 차단 해소)
        maxStrength: 0.5, // ★ Not too advanced
        maxConsecutiveBars: 3, // ★ CRITICAL filter (최적화: 4 → 3, win rate 67%)
        emaPeriod: 20,
      },
      m15: {
        trendBars: 4,
        minStrength: 0.2,
        maxStrength: 0.6,
        mustAlignWithH1: true,
      },
      m5: {
        pullbackBars: 3,
        minPullbackDepthAtr: 0.6, // 개선: 0.5 → 0.6 (더 깊은 풀백 요구)
        maxPullbackDepthAtr: 1.0, // 개선: 1.2 → 1.0 (과도한 풀백 = 추세 반전 가능성)
        cvdConfirmBars: 3,
        cvdMinRatio: 0.05, // 개선: 3% → 5% (CVD 확인 강화)
        requireConfirmCandle: true, // 개선: 풀백 후 확인봉 필수
      },
      emaFilter: {
        enabled: true,
        ema7Period: 7,
        ema20Period: 20,
      },
      fundingFilter: {
        longMax: 0.0003, // <0.03% for long
        shortMin: -0.0003, // >-0.03% for short
      },
      // NEW: RSI 모멘텀 반전 필터 (과매수/과매도 진입 방지)
      rsiFilter: {
        enabled: true,
        period: 14,
        // SHORT 진입 시: RSI가 이미 과매도면 반전 가능성 → 차단
        shortOversoldThreshold: 35,  // RSI < 35면 SHORT 금지
        // LONG 진입 시: RSI가 이미 과매수면 반전 가능성 → 차단
        longOverboughtThreshold: 65, // RSI > 65면 LONG 금지
      },
      tpSl: {
        slAtrMultiple: 1.2, // 개선: 1.0 → 1.2 (SL 여유 확보)
        minSlPercent: 0.008, // 개선: 0.6% → 0.8%
        maxSlPercent: 0.020, // 개선: 1.5% → 2.0%
        tp1RR: 1.0, // 개선: 1.2 → 1.0 (TP1 빠르게 확보)
        tp2RR: 1.5, // 개선: 1.8 → 1.5 (현실적인 목표)
      },
    },

    // 2. Relative Strength Leader
    relativeStrength: {
      enabled: true,
      rsPeriod: 12, // 최적화: 24 → 12 hours (단기 주도주 포착 민감도 상향)
      rsTimeframe: '1h',
      topRsCount: 15, // 최적화: 10 → 15 (대상 종목 확대, 매매 횟수 증대)
      bottomRsCount: 15, // 최적화: 10 → 15
      btcTurnConfirmBars: 2,
      btcEmaFast: 7,
      btcEmaSlow: 20,
      requirePullback: true,
      cvdConfirmRequired: true,
      minDailyVolume: 50000000, // $50M
      tpSl: {
        slAtrMultiple: 1.0,
        tp1RR: 1.5,
        tp2RR: 2.0,
      },
    },

    // 3. Funding Extremes (counter-trend)
    fundingExtremes: {
      enabled: true,
      fundingHistoryPeriod: 168, // 7 days (hours)
      extremeZScore: 2.0, // 2 standard deviations (유지)
      extremeHighAbsolute: 0.0005, // 최적화: 0.1% → 0.05% (펀딩비가 조금만 치우쳐도 반전 기회 포착)
      extremeLowAbsolute: -0.0005, // 최적화: -0.1% → -0.05%
      momentumSlowingBars: 2, // 최적화: 3 → 2 (92% 차단 해소, 모멘텀 반전 조기 포착)
      rsiOverbought: 70,
      rsiOversold: 30,
      confirmationRequired: true,
      tpSl: {
        slAtrMultiple: 1.0,
        tp1RR: 1.8,
        tp2RR: 2.5, // Higher target as funding normalizes
      },
    },
  },
};
