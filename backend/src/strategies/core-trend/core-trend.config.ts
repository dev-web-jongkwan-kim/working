import { IStrategyConfig } from '../core/interfaces';

/**
 * Core Trend Strategy Configuration
 * Based on improve.md specifications:
 * - Signal TF: 1D (daily EMA 50/200)
 * - Entry TF: 4H (pullback/breakout entry)
 */
export interface CoreTrendConfig extends IStrategyConfig {
  /** Timeframe configurations */
  timeframes: {
    /** Signal timeframe for trend direction */
    signal: '1d';
    /** Entry timeframe for entry triggers */
    entry: '4h';
  };

  /** Trend detection parameters */
  trend: {
    /** Fast EMA period on 1D */
    emaFast1d: number;
    /** Slow EMA period on 1D */
    emaSlow1d: number;
    /** Minimum EMA separation for trend confirmation (percent) */
    minEmaSeparationPct: number;
  };

  /** Entry parameters */
  entry: {
    /** ATR period for 4H */
    atrLen4h: number;
    /** Pullback depth threshold (ATR multiplier) */
    pullbackAtrMult: number;
    /** Use limit orders for entry */
    useLimitEntry: boolean;
    /** Limit order timeout in bars (entry TF) - converts to market after timeout */
    limitTimeoutBars: number;
  };

  /** Exit parameters */
  exit: {
    /** SL distance in ATR multiples */
    slAtrMult: number;
    /** TP1 R-multiple */
    tp1R: number;
    /** TP1 quantity percentage */
    tp1QtyPct: number;
    /** Trailing stop ATR multiple */
    trailAtrMult: number;
    /** Time stop in 4H bars */
    timeStopBars4h: number;
  };

  /** Position parameters */
  position: {
    /** Base leverage */
    leverage: number;
    /** Maximum margin per trade in USD (cap, not target - actual margin calculated from risk) */
    maxMarginUsd: number;
    /** Cooldown period in 4H bars */
    cooldownBars: number;
  };
}

/**
 * Default Core Trend configuration
 */
export const CORE_TREND_CONFIG: CoreTrendConfig = {
  enabled: true,
  maxPositions: 3,
  cooldownBars: 4,

  risk: {
    riskPerTrade: 0.005, // 0.5%
    dailyLossLimit: 0.01, // 1%
  },

  timeframes: {
    signal: '1d',
    entry: '4h',
  },

  trend: {
    emaFast1d: 50,
    emaSlow1d: 200,
    minEmaSeparationPct: 0.5, // 0.5% minimum separation
  },

  entry: {
    atrLen4h: 14,
    pullbackAtrMult: 1.0, // Pullback within 1 ATR from fast EMA
    useLimitEntry: true,
    limitTimeoutBars: 1, // 1 bar = 4H, then convert to market
  },

  exit: {
    slAtrMult: 2.0,
    tp1R: 1.0,
    tp1QtyPct: 0.3, // 30%
    trailAtrMult: 2.5,
    timeStopBars4h: 30,
  },

  position: {
    leverage: 10,
    maxMarginUsd: 100, // Cap only - actual margin from risk-based sizing
    cooldownBars: 4,
  },
};
