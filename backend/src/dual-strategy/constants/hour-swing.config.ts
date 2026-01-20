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

  // Sub-strategies
  subStrategies: {
    // 1. MTF Alignment + Pullback
    mtfAlignment: {
      enabled: true,
      h1: {
        trendBars: 6,
        minStrength: 0.07, // 최적화: 0.15 → 0.10 → 0.07 (보수적 완화, 99% 차단 해소)
        maxStrength: 0.5, // ★ Not too advanced
        maxConsecutiveBars: 4, // ★ CRITICAL filter
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
