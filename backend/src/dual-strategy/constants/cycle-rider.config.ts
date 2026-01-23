/**
 * Strategy A: Cycle Rider Configuration
 * Goal: Capture entire trend cycles
 */

export const CYCLE_RIDER_CONFIG = {
  // Position management
  position: {
    leverage: 15, // 최적화: 10 → 15 (소액 시드, 추세 확인 시 비중 확대)
    marginUsd: 50,
    maxPositions: 5, // 최적화: 3 → 5 (강세장 기회비용 감소)
    maxSameDirection: 3, // maxPositions 증가에 따라 조정
    minHoldMinutes: 30,
    maxHoldMinutes: 240, // 4 hours
    tp1ClosePercent: 25, // 최적화: 50 → 25 (추세 몸통 수익 보존 비중 확대)
    cooldownMinutes: 30, // 최적화: 15 → 30 (손절 후 시장 안정 대기)
  },

  // Trailing stop
  trailing: {
    enabled: true,
    activateAfterTp1: true,
    distanceAtr: 2.5, // 최적화: 1.0 → 2.5 ATR (고점 도달 후 되돌림 시 자동 청산)
    stepAtr: 0.3,
  },

  // Time-based actions
  timeBasedActions: {
    after60MinProfit: { trailingDistanceAtr: 0.7 },
    after120MinProfit: { trailingDistanceAtr: 0.5 },
    after180Min: { closeIfProfitPercent: 0 },
  },

  // Common filters (CRITICAL!)
  filters: {
    maxConsecutiveBars: 3, // ★ Core filter to avoid late entry
    minAtrPercent: 0.0045, // 최적화: 0.3% → 0.45% (저변동성 노이즈 진입 차단)
    maxAtrPercent: 0.03, // 3%
    maxSpreadPercent: 0.0007, // 0.07%
    maxAbsFundingRate: 0.001, // |funding| > 0.1% warning
    minVolumeRank: 0.3, // Top 70%
  },

  // Regime-based RSI filter (NEW: prevent counter-trend entries without extreme RSI)
  regimeRsiFilter: {
    enabled: true,
    rsiPeriod: 14,
    // STRONG_DOWNTREND: LONG only when RSI shows extreme oversold
    strongDowntrendLongMaxRsi: 20,
    // WEAK_DOWNTREND: LONG requires lower RSI (more caution)
    weakDowntrendLongMaxRsi: 30,
    // WEAK_UPTREND: SHORT requires higher RSI (more caution)
    weakUptrendShortMinRsi: 70,
    // STRONG_UPTREND: SHORT only when RSI shows extreme overbought
    strongUptrendShortMinRsi: 80,
  },

  // Sub-strategies
  subStrategies: {
    // 1. Accumulation (Wyckoff)
    accumulation: {
      enabled: true,
      boxPeriod: 20,
      boxRangeMaxAtr: 2.0,
      supportTestThreshold: 0.003, // ±0.3%
      minSupportTests: 2,
      cvdPeriod: 10,
      cvdSlopeThreshold: 0.025, // 최적화: 0.02 → 0.025 (스마트 머니 매집 확인 강화)
      springBreakPercent: 0.01, // 1%
      springMaxBreakPercent: 0.03, // 3%
      springRecoveryBars: 3,
      springVolumeMultiple: 1.5,
      minConfidence: 70,
      tpSl: {
        slAtrMultiple: 0.3,
        tp1Type: 'box_top',
        tp2Type: 'box_top_plus_range',
        useTrailing: true,
      },
    },

    // 2. Distribution (inverse of accumulation)
    distribution: {
      enabled: true,
      boxPeriod: 20,
      boxRangeMaxAtr: 2.0,
      resistanceTestThreshold: 0.003,
      minResistanceTests: 2,
      cvdPeriod: 10,
      cvdSlopeThreshold: -0.025, // 최적화: -0.02 → -0.025 (스마트 머니 매도 확인 강화)
      utadBreakPercent: 0.01,
      utadMaxBreakPercent: 0.03,
      utadRejectionBars: 3,
      utadVolumeMultiple: 1.5,
      minConfidence: 70,
      tpSl: {
        slAtrMultiple: 0.3,
        tp1Type: 'box_bottom',
        tp2Type: 'box_bottom_minus_range',
        useTrailing: true,
      },
    },

    // 3. Divergence
    divergence: {
      enabled: true,
      swingLookback: 5,
      minSwingDistance: 10,
      maxSwingDistance: 50,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      priceDivergenceMin: 0.005, // 0.5%
      minIndicatorsConfirm: 2, // RSI, CVD, OI중 2개 이상
      confirmationPatterns: [
        'HAMMER',
        'INVERTED_HAMMER',
        'BULLISH_ENGULFING',
        'BEARISH_ENGULFING',
        'MORNING_STAR',
        'EVENING_STAR',
      ],
      minStrength: 60,
      tpSl: {
        slAtrMultiple: 1.0,
        tp1RR: 2.0,
        tp2RR: 3.0,
        useTrailing: true,
      },
    },

    // 4. Volume Climax
    volumeClimax: {
      enabled: true,
      volumeAvgPeriod: 20,
      minVolumeMultiple: 2.0, // 최적화: 2.5 → 2.0 (진입 기회 확대 + 노이즈 필터 균형)
      minCandleSizeAtr: 1.4, // 1.4x ATR (완화: 2.0 → 1.4, 캔들 크기 조건 완화)
      rsiPeriod: 14,
      rsiBuyingClimax: 75,
      rsiSellingClimax: 25,
      entryDelay: 2, // Wait 2 bars after climax (최적화: 1 → 2, 반전 확인 시간 확보)
      requireTrendExhaustion: true,
      minTrendBars: 5,
      // RSI re-confirmation at entry (prevent late entry after recovery)
      requireRsiStillExtreme: true,
      rsiReentryLong: 35, // For LONG entry, RSI must still be < 35
      rsiReentryShort: 65, // For SHORT entry, RSI must still be > 65
      tpSl: {
        slAtrMultiple: 1.0,
        tp1RR: 1.5, // 1.5 R:R (최적화: 피보나치 → R:R 기반)
        tp2RR: 4.0, // 최적화: 2.5 → 4.0 (크게 먹는 구간에서 끝까지 홀딩)
        useTrailing: false,
      },
    },

    // 5. Squeeze (Bollinger Bands / Keltner Channel)
    squeeze: {
      enabled: true,
      bbPeriod: 20,
      bbStdDev: 2.0,
      kcPeriod: 20,
      kcAtrMultiple: 1.5,
      minSqueezeBars: 6,
      momentumPeriod: 12,
      minMomentumStrength: 30,
      minAdx: 18, // 최적화: 20 → 18 (추세 형성 초기 단계에서 미리 진입)
      minRvol: 1.5, // 볼륨 배수 최소값
      tpSl: {
        slAtrMultiple: 1.0,
        tp1AtrMultiple: 2.0,
        tp2AtrMultiple: 3.0,
        useTrailing: true,
      },
    },
  },
};
