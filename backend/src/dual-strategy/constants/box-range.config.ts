/**
 * Box Range Strategy Configuration
 * Strategy C: Sideways market box trading
 */

export const BOX_RANGE_CONFIG = {
  // ═══════════════════════════════════════════════════════════
  // Strategy Basic Info
  // ═══════════════════════════════════════════════════════════
  name: 'BOX_RANGE',
  description: 'Box range trading - Upper/Lower boundary reversal',
  timeframe: '15m',
  enabled: true,

  // ═══════════════════════════════════════════════════════════
  // Position Settings
  // ═══════════════════════════════════════════════════════════
  position: {
    baseLeverage: 15, // Base leverage (adjusted by grade) - 최적화: 5 → 15 (3배 증가)
    marginUsd: 30, // 최적화: $20 → $30 (1.5배 증가)
    maxPositions: 4, // Max simultaneous positions
    maxSameDirection: 1, // Max 1 same direction (prevent simultaneous loss)
    cooldownMinutes: 15, // Re-entry cooldown (same as other strategies)
  },

  // ═══════════════════════════════════════════════════════════
  // Box Definition Conditions
  // ═══════════════════════════════════════════════════════════
  boxDefinition: {
    // Swing Point Settings
    swing: {
      depth: 5, // ZigZag depth (candles left/right)
      minHighs: 2, // Minimum Swing Highs
      minLows: 2, // Minimum Swing Lows
      maxDeviationAtr: 2.0, // Max swing point deviation (ATR multiple) - relaxed from 0.8
      minAbsoluteDeviation: 0.06, // Minimum absolute deviation (relaxed from 0.03)
      highQualityMaxDeviation: 0.05, // HIGH quality threshold (0~0.05)
      mediumQualityMaxDeviation: 0.06, // MEDIUM quality threshold (0.05~0.06)
    },

    // Symbol-specific Box Height (ATR-based)
    symbolTypes: {
      stable: {
        // BTC, ETH
        symbols: ['BTCUSDT', 'ETHUSDT'],
        minAtr: 1.5,
        maxAtr: 2.0,
        optimalMinAtr: 1.5,
        optimalMaxAtr: 1.8,
      },
      altcoin: {
        // SOL, XRP, ADA, etc.
        symbols: [], // Auto-detect by volume rank
        minAtr: 2.0,
        maxAtr: 4.5,
        optimalMinAtr: 2.0,
        optimalMaxAtr: 4.0,
      },
      highVolatility: {
        // MEME coins, new listings
        symbols: [], // Auto-detect by ATR %
        minAtr: 4.0,
        maxAtr: 5.0,
        optimalMinAtr: 4.0,
        optimalMaxAtr: 5.0,
      },
    },

    // Box Height Conditions (default fallback)
    height: {
      minAtr: 2.0, // Min box height (ATR × 2.0)
      maxAtr: 4.5, // Max box height (ATR × 4.5)
      optimalMinAtr: 2.0, // Optimal range start
      optimalMaxAtr: 4.0, // Optimal range end
    },

    // Time Conditions
    time: {
      minCandles: 20, // 최적화: 16 → 24 → 20 (5시간, 균형잡힌 설정)
      warningCandles: 48, // Warning age (12 hours, reduce size)
      maxCandles: 72, // Max age (18 hours, stop entry)
      expireCandles: 96, // Expiration (24 hours, invalidate box)
    },

    // ADX Conditions (confirm no trend)
    adx: {
      maxValue: 28, // 최적화: 20 → 28 (완벽한 횡보가 아니더라도 박스권이면 진입)
      maxDiDiff: 10, // |+DI - -DI| < 10
      requireDeclining: false, // 최적화: true → false (절대값만 체크, 횡보장 진입 기회 확대)
      slopeLookback: 3, // Check slope over 3 candles
    },

    // Volume Profile Conditions
    volume: {
      centerRatio: 0.775, // 최적화: 0.8 → 0.85 → 0.775 (77.5%, 횡보장 기회 대폭 확대)
      edgeRatio: 1.2, // Edge volume > avg × 1.2
      lookbackCandles: 50, // Volume analysis candle count
    },
  },

  // ═══════════════════════════════════════════════════════════
  // Upper Timeframe Filter
  // ═══════════════════════════════════════════════════════════
  upperTimeframeFilter: {
    enabled: true,
    h1: {
      maxAdx: 35, // Disable if 1H ADX > 35 (완화: 30 → 35)
    },
    h4: {
      trendAlignment: false, // 4H filter disabled per user request
      trendBars: 3, // Determine trend from recent 3 bars
    },
  },

  // ═══════════════════════════════════════════════════════════
  // Entry Conditions
  // ═══════════════════════════════════════════════════════════
  entry: {
    entryZonePercent: 0.20, // 최적화: 0.15 → 0.20 (진입 기회 확대, 상단/하단 20%)

    // SFP (Sweep/Fake Breakout) Filter
    sfpFilter: {
      enabled: true,
      minBreachPercent: 0.003, // 최적화: 0.5% → 0.3% (상위 100개 종목 빠른 복귀 대응)
      maxBreachPercent: 0.008, // 최적화: 1.0% → 0.8% (상위 100개 종목 빠른 복귀 대응)
      returnCandleCount: 2, // Must return within 2 candles (30 minutes)
      requireReturn: true, // Must return inside box
    },

    // RSI Slope Filter (prevent aggressive breakouts)
    rsiSlopeFilter: {
      enabled: true,
      lookbackCandles: 3, // Check last 3 candles
      maxChange: 30, // Max 30-point RSI change = breakout signal
    },

    // Volume Decay Filter (support/resistance working)
    volumeDecayFilter: {
      enabled: true,
      maxVolumeRatio: 0.70, // Current volume < 70% of average
      lookbackCandles: 20, // Average over 20 candles
    },

    // Long Entry Conditions
    long: {
      maxRsi: 35, // RSI < 35
      requireBullishCandle: true, // Require bullish candle
      maxBreachPercent: 0.002, // Allow 0.2% breach below box
    },

    // Short Entry Conditions
    short: {
      minRsi: 65, // RSI > 65
      requireBearishCandle: true, // Require bearish candle
      maxBreachPercent: 0.002, // Allow 0.2% breach above box
    },

    // Common Conditions
    common: {
      momentumDecay: true, // Confirm momentum decay
      momentumLookback: 3, // Compare recent 3 candles
      maxConsecutiveBars: 2, // Limit consecutive same-direction bars
    },
  },

  // ═══════════════════════════════════════════════════════════
  // SL/TP Settings
  // ═══════════════════════════════════════════════════════════
  slTp: {
    slBufferAtr: 0.5, // 최적화: 0.3 → 0.5 ATR (휩소에 의한 잦은 손절 방지)

    // 2-stage partial profit taking (aligned with other strategies)
    tp1: {
      usePOC: true, // Use POC (Point of Control) from volume profile
      fallbackPercent: 0.5, // Fallback to 50% of box height if POC unavailable
      closePercent: 70, // Close 70% (more aggressive first exit)
    },
    tp2: {
      targetPercent: 0.90, // 90% of box height (near opposite boundary)
      closePercent: 30, // Close 30%
      useTrailingStop: true, // Use trailing stop for TP2
      trailingStopAtr: 0.5, // 0.5 ATR trailing stop
    },

    // Move SL to breakeven + 0.1% after TP1
    moveSlToEntryAfterTp1: true,
    slBreakevenBuffer: 0.001, // 0.1% above entry
  },

  // ═══════════════════════════════════════════════════════════
  // Funding Rate Integration
  // ═══════════════════════════════════════════════════════════
  fundingBias: {
    enabled: true,
    threshold: 0.0008, // 0.08% (moderate threshold per user request)
    extremeThreshold: 0.0008, // 0.08% (same as threshold - block counter-direction)
    // Funding > +0.08%: Block LONG
    // Funding < -0.08%: Block SHORT
  },

  // ═══════════════════════════════════════════════════════════
  // Box Grading System
  // ═══════════════════════════════════════════════════════════
  boxGrade: {
    enabled: true,
    grades: {
      A: {
        minConfidence: 85,
        leverage: 15,
        sizePercent: 100,
        allowedHours: { start: 0, end: 24 }, // All hours
      },
      B: {
        minConfidence: 70,
        leverage: 12,
        sizePercent: 75,
        allowedHours: { start: 9, end: 23 }, // 9AM-11PM KST
      },
      C: {
        minConfidence: 60,
        leverage: 9,
        sizePercent: 50,
        allowedHours: { start: 9, end: 15 }, // 9AM-3PM KST only
      },
    },
    rejectBelowConfidence: 60, // Reject entry below 60 points
  },

  // ═══════════════════════════════════════════════════════════
  // Time Filter (KST timezone)
  // ═══════════════════════════════════════════════════════════
  timeFilter: {
    enabled: true,
    // 최적화: 20:30-01:30 → 22:00-00:30 KST (미 증시 초반 변동성만 피하고 기회 확보)
    disabledHours: {
      start: 22.0, // 22:00 KST
      end: 0.5,    // 00:30 KST (next day) (converted to 24-hour decimal)
    },
    // Time-based size adjustment (removed, using grade-based sizing)
    sessionAdjustment: {
      enabled: false,
    },
  },

  // ═══════════════════════════════════════════════════════════
  // Box Breakout Response
  // ═══════════════════════════════════════════════════════════
  breakoutProtection: {
    // Breakout detection threshold
    thresholdPercent: 0.005, // 0.5%+ breach beyond box boundary

    // Early warning (volume surge detection)
    earlyWarning: {
      enabled: true,
      volumeMultiplier: 2.0, // Volume 2x+ above average
      action: 'REDUCE_SIZE', // Reduce size to 50%
    },

    // Breakout action
    onBreakout: 'CLOSE_ALL', // Close all positions for that symbol

    // Post-breakout cooldown
    cooldownMinutes: 30,
  },

  // ═══════════════════════════════════════════════════════════
  // Conflict Resolution
  // ═══════════════════════════════════════════════════════════
  conflictResolution: {
    // Cycle Rider has priority
    cycleRiderPriority: true,

    // Disable Box Range when Spring/Upthrust detected
    disableOnCycleRiderSignal: true,
    disableDurationMinutes: 1440, // 24 hours

    // Same symbol simultaneous signal handling
    onConflict: 'PREFER_CYCLE_RIDER',
  },

  // ═══════════════════════════════════════════════════════════
  // Confidence Score Weights
  // ═══════════════════════════════════════════════════════════
  confidence: {
    weights: {
      touchCount: 1.0, // Touch count (max 25 points)
      adxScore: 1.0, // ADX lower is better (max 25 points)
      boxHeightScore: 1.0, // Optimal height (max 25 points)
      ageScore: 1.0, // Appropriate age (max 25 points)
    },
    // Scoring details
    scoring: {
      // Touch count (total swing points)
      touch: {
        perTouch: 5, // 5 points per touch
        max: 25, // Max 25 points
      },
      // ADX (lower is better)
      adx: {
        under15: 25,
        under20: 20,
        under25: 10,
      },
      // Box height (2-3 ATR optimal)
      height: {
        optimal: 25, // 2-3 ATR
        acceptable: 15, // 1.5-4 ATR
      },
      // Box age
      age: {
        optimal: 25, // 6-12 hours
        acceptable: 15, // 4-18 hours
        minimum: 10, // 4+ hours
      },
    },
  },

  // ═══════════════════════════════════════════════════════════
  // Common Filters (same as existing strategies)
  // ═══════════════════════════════════════════════════════════
  filters: {
    minAtrPercent: 0.002, // 0.2% (완화: 0.3% → 0.2%)
    maxAtrPercent: 0.035, // 3.5% (완화: 2.5% → 3.5%)
    maxSpreadPercent: 0.0007, // 0.07%
    minVolumeRank: 0.3, // Top 70% by volume
  },
};
