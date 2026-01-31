import { IStrategyConfig } from '../core/interfaces';

/**
 * Squeeze Strategy Configuration
 * Based on improve.md specifications:
 * - Detect TF: 1H (BB compression detection)
 * - Entry TF: 15m (breakout confirmation)
 */
export interface SqueezeConfig extends IStrategyConfig {
  /** Timeframe configurations */
  timeframes: {
    /** Detection timeframe for compression */
    detect: '1h';
    /** Entry timeframe for breakout */
    entry: '15m';
  };

  /** Compression detection parameters */
  compression: {
    /** Bollinger Band period on 1H */
    bbLen1h: number;
    /** Bollinger Band standard deviation multiplier */
    bbK1h: number;
    /** Lookback period for percentile calculation */
    compressLookback1h: number;
    /** Percentile threshold for compression (e.g., 0.15 = lowest 15%) */
    compressPercentile: number;
    /** Minimum bars in compression before valid */
    minBarsInCompression: number;
  };

  /** Breakout detection parameters */
  breakout: {
    /** Lookback for box high/low detection on 15m */
    breakoutLookback15m: number;
    /** Require close outside box (not just wick) */
    requireCloseBreak: boolean;
    /** Retest mode: 'off' | 'optional' | 'required' */
    retestMode: 'off' | 'optional' | 'required';
    /** Retest timeout in bars */
    retestTimeoutBars: number;
  };

  /** Exit parameters */
  exit: {
    /** ATR period for 1H */
    atrLen1h: number;
    /** SL buffer from box edge in ATR multiples */
    slStructureBufferAtrMult: number;
    /** TP1 R-multiple (Net after costs) */
    tp1R: number;
    /** TP1 quantity percentage */
    tp1QtyPct: number;
    /** Trailing stop ATR multiple */
    trailAtrMult: number;
    /** Time stop in 15m bars after TP1 hit (0 = disabled) */
    timeStopBars15m: number;
  };

  /** Position parameters */
  position: {
    /** Base leverage */
    leverage: number;
    /** Maximum margin per trade in USD (cap, not target - actual margin calculated from risk) */
    maxMarginUsd: number;
    /** Cooldown period in 15m bars */
    cooldownBars: number;
  };
}

/**
 * Default Squeeze configuration
 */
export const SQUEEZE_CONFIG: SqueezeConfig = {
  enabled: true,
  maxPositions: 3,
  cooldownBars: 4,

  risk: {
    riskPerTrade: 0.005, // 0.5%
    dailyLossLimit: 0.01, // 1%
  },

  timeframes: {
    detect: '1h',
    entry: '15m',
  },

  compression: {
    bbLen1h: 20,
    bbK1h: 2.0,
    compressLookback1h: 120,
    compressPercentile: 0.15,
    minBarsInCompression: 3,
  },

  breakout: {
    breakoutLookback15m: 32,
    requireCloseBreak: true,
    retestMode: 'required', // P1-3: Require retest to filter false breakouts
    retestTimeoutBars: 8,
  },

  exit: {
    atrLen1h: 14,
    slStructureBufferAtrMult: 0.2,
    tp1R: 1.0, // Net R (after costs)
    tp1QtyPct: 0.25, // 25%
    trailAtrMult: 2.2,
    timeStopBars15m: 24, // P1-2: 24 bars = 6 hours after TP1
  },

  position: {
    leverage: 10,
    maxMarginUsd: 100, // Cap only - actual margin from risk-based sizing
    cooldownBars: 4,
  },
};
