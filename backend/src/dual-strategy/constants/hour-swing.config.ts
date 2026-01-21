/**
 * Strategy B: Hour Swing Configuration
 * Goal: Quick confirmed profits within 1 hour
 */

export const HOUR_SWING_CONFIG = {
  // Position management
  position: {
    leverage: 20, // 최적화: 12 → 10 → 20 (마진 증가)
    marginUsd: 30, // 최적화: 15 → 30 (거래 빈도 증가 대응)
    maxPositions: 5,
    maxSameDirection: 3,
    minHoldMinutes: 15,
    maxHoldMinutes: 60,
    tp1ClosePercent: 50,
    cooldownMinutes: 10,
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

  // Regime filter (NEW: prevent counter-trend entries)
  regimeFilter: {
    enabled: true,
    // Block LONG during strong downtrend, SHORT during strong uptrend
    blockCounterTrend: true,
    // Only allow trades in these regimes (empty = allow all)
    allowedRegimes: [], // Will filter STRONG_DOWNTREND/UPTREND in code
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
        minPullbackDepthAtr: 0.5, // 최적화: 0.3 → 0.5 (타점 정밀화 - 허수 제거)
        maxPullbackDepthAtr: 1.2, // 최적화: 1.5 → 1.2 (타점 정밀화 - 허수 제거)
        cvdConfirmBars: 3,
        cvdMinRatio: 0.03, // 3%
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
        slAtrMultiple: 1.0,
        minSlPercent: 0.006, // 0.6%
        maxSlPercent: 0.015, // 1.5%
        tp1RR: 1.2,
        tp2RR: 1.8,
      },
    },

    // 2. Relative Strength Leader
    relativeStrength: {
      enabled: true,
      rsPeriod: 12, // 최적화: 24 → 12 hours (단기 주도주 포착 민감도 상향)
      rsTimeframe: '1h',
      topRsCount: 10,
      bottomRsCount: 10,
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
      extremeHighAbsolute: 0.001, // 0.1%
      extremeLowAbsolute: -0.001,
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
