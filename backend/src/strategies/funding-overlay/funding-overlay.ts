import {
  FundingAction,
  TradingSignal,
  TradeDirection,
} from '../core/interfaces';
import {
  analyzeFunding,
  adjustForFunding,
  calculateFundingPercentile,
  calculateFundingZScore,
  FundingAnalysis,
} from '../core/indicators';

/**
 * Funding Overlay Configuration
 * Based on improve.md specifications
 */
export interface FundingOverlayConfig {
  /** Whether funding overlay is enabled */
  enabled: boolean;

  /** Number of historical funding samples for percentile calculation */
  lookbackSamples: number;

  /** High percentile threshold (e.g., 0.9 = 90th percentile) */
  highPctl: number;

  /** Low percentile threshold (e.g., 0.1 = 10th percentile) */
  lowPctl: number;

  /** Minimum absolute funding rate to trigger extreme (e.g., 0.0005 = 0.05%) */
  minAbsRateForExtreme: number;

  /** Action on extreme funding: 'tighten' or 'block' */
  onExtreme: 'tighten' | 'block';

  /** Tighten parameters */
  tighten: {
    /** Amount to add to TP1 quantity percent */
    tp1QtyPctAdd: number;
    /** Amount to subtract from trail ATR multiplier */
    trailAtrMultSub: number;
  };
}

/**
 * Default Funding Overlay configuration
 */
export const FUNDING_OVERLAY_CONFIG: FundingOverlayConfig = {
  enabled: true,
  lookbackSamples: 200,
  highPctl: 0.9,
  lowPctl: 0.1,
  minAbsRateForExtreme: 0.0005, // 0.05% - must exceed this AND percentile threshold
  onExtreme: 'tighten',
  tighten: {
    tp1QtyPctAdd: 0.1,
    trailAtrMultSub: 0.3,
  },
};

/**
 * Funding Overlay result
 */
export interface FundingOverlayResult {
  /** Action to take */
  action: FundingAction;

  /** Current funding rate */
  currentRate: number | null;

  /** Funding percentile (0-1) */
  percentile: number | null;

  /** Z-score for extreme detection */
  zScore: number | null;

  /** Whether funding is extreme */
  isExtreme: boolean;

  /** Direction of extreme: HIGH (longs paying), LOW (shorts paying) */
  extremeDirection: 'HIGH' | 'LOW' | null;

  /** Adjusted TP1 qty percent (if tightened) */
  adjustedTp1QtyPct?: number;

  /** Adjusted trail ATR mult (if tightened) */
  adjustedTrailAtrMult?: number;

  /** Explanation for the action */
  reason: string;
}

/**
 * Funding Overlay Service
 *
 * Adjusts trade parameters based on funding rate conditions.
 * Not a standalone strategy - works as an overlay on Core Trend and Squeeze.
 *
 * Actions:
 * - ALLOW: Normal trading, no adjustments
 * - TIGHTEN: Faster profit taking, tighter trailing stop
 * - BLOCK: Skip trade entirely (optional, default is tighten)
 */
export class FundingOverlay {
  private config: FundingOverlayConfig;

  constructor(config: Partial<FundingOverlayConfig> = {}) {
    this.config = { ...FUNDING_OVERLAY_CONFIG, ...config };
  }

  /**
   * Analyze funding and determine action
   *
   * @param currentRate Current funding rate
   * @param historicalRates Historical funding rates
   * @param direction Intended trade direction
   * @returns Funding overlay result
   */
  analyze(
    currentRate: number | null,
    historicalRates: number[],
    direction: TradeDirection,
  ): FundingOverlayResult {
    // If overlay is disabled or no data, allow
    if (!this.config.enabled || currentRate === null) {
      return {
        action: 'ALLOW',
        currentRate,
        percentile: null,
        zScore: null,
        isExtreme: false,
        extremeDirection: null,
        reason: 'Funding overlay disabled or no data',
      };
    }

    // Need sufficient history
    if (historicalRates.length < 50) {
      return {
        action: 'ALLOW',
        currentRate,
        percentile: null,
        zScore: null,
        isExtreme: false,
        extremeDirection: null,
        reason: `Insufficient funding history (${historicalRates.length}/50)`,
      };
    }

    // Calculate percentile and z-score
    const percentile = calculateFundingPercentile(currentRate, historicalRates);
    const zScore = calculateFundingZScore(currentRate, historicalRates);

    if (percentile === null) {
      return {
        action: 'ALLOW',
        currentRate,
        percentile: null,
        zScore,
        isExtreme: false,
        extremeDirection: null,
        reason: 'Could not calculate funding percentile',
      };
    }

    // Determine if extreme (requires BOTH percentile AND absolute value thresholds)
    // P1-1: Added absolute value guard to prevent false extremes in quiet markets
    const absRate = Math.abs(currentRate);
    const meetsAbsThreshold = absRate >= this.config.minAbsRateForExtreme;

    const isHighExtreme = percentile >= this.config.highPctl && meetsAbsThreshold;
    const isLowExtreme = percentile <= this.config.lowPctl && meetsAbsThreshold;
    const isExtreme = isHighExtreme || isLowExtreme;
    const extremeDirection = isHighExtreme ? 'HIGH' : isLowExtreme ? 'LOW' : null;

    // If not extreme, allow
    if (!isExtreme) {
      const reason = !meetsAbsThreshold && (percentile >= this.config.highPctl || percentile <= this.config.lowPctl)
        ? `Funding percentile extreme but abs rate ${(absRate * 100).toFixed(3)}% below threshold`
        : `Funding normal (${(percentile * 100).toFixed(0)}th percentile)`;
      return {
        action: 'ALLOW',
        currentRate,
        percentile,
        zScore,
        isExtreme: false,
        extremeDirection: null,
        reason,
      };
    }

    // Check if extreme is unfavorable for direction
    // HIGH funding = longs paying shorts = unfavorable for LONG
    // LOW funding = shorts paying longs = unfavorable for SHORT
    const isUnfavorable =
      (direction === 'LONG' && isHighExtreme) ||
      (direction === 'SHORT' && isLowExtreme);

    if (!isUnfavorable) {
      // Extreme but favorable (collecting funding)
      return {
        action: 'ALLOW',
        currentRate,
        percentile,
        zScore,
        isExtreme: true,
        extremeDirection,
        reason: `Funding extreme but favorable for ${direction}`,
      };
    }

    // Unfavorable extreme - determine action
    if (this.config.onExtreme === 'block') {
      return {
        action: 'BLOCK',
        currentRate,
        percentile,
        zScore,
        isExtreme: true,
        extremeDirection,
        reason: `Blocking ${direction}: funding at ${(percentile * 100).toFixed(0)}th percentile`,
      };
    }

    // Tighten parameters
    return {
      action: 'TIGHTEN',
      currentRate,
      percentile,
      zScore,
      isExtreme: true,
      extremeDirection,
      reason: `Tightening ${direction}: funding at ${(percentile * 100).toFixed(0)}th percentile`,
    };
  }

  /**
   * Apply funding overlay adjustments to a signal
   *
   * @param signal Original trading signal
   * @param fundingResult Funding overlay analysis result
   * @returns Adjusted signal (or null if blocked)
   */
  applyToSignal(
    signal: TradingSignal,
    fundingResult: FundingOverlayResult,
  ): TradingSignal | null {
    // Block trade
    if (fundingResult.action === 'BLOCK') {
      return null;
    }

    // No adjustment needed
    if (fundingResult.action === 'ALLOW') {
      return {
        ...signal,
        fundingAction: 'ALLOW',
        metadata: {
          ...signal.metadata,
          fundingRate: fundingResult.currentRate || undefined,
          fundingPctl: fundingResult.percentile || undefined,
        },
      };
    }

    // Tighten parameters
    const adjustedTp1QtyPercent = Math.min(
      signal.tp1QtyPercent + this.config.tighten.tp1QtyPctAdd,
      0.5, // Cap at 50%
    );

    const adjustedTrailAtrMult = Math.max(
      signal.trailAtrMult - this.config.tighten.trailAtrMultSub,
      1.5, // Minimum 1.5 ATR
    );

    return {
      ...signal,
      tp1QtyPercent: adjustedTp1QtyPercent,
      trailAtrMult: adjustedTrailAtrMult,
      fundingAction: 'TIGHTEN',
      metadata: {
        ...signal.metadata,
        fundingRate: fundingResult.currentRate || undefined,
        fundingPctl: fundingResult.percentile || undefined,
        fundingAdjusted: true,
        originalTp1QtyPercent: signal.tp1QtyPercent,
        originalTrailAtrMult: signal.trailAtrMult,
      },
    };
  }

  /**
   * Check if should continue holding a position based on funding
   * Used during position management
   *
   * @param currentRate Current funding rate
   * @param historicalRates Historical funding rates
   * @param direction Position direction
   * @returns Whether to continue holding (true) or consider early exit (false)
   */
  shouldContinueHolding(
    currentRate: number | null,
    historicalRates: number[],
    direction: TradeDirection,
  ): { shouldHold: boolean; reason: string } {
    if (!this.config.enabled || currentRate === null) {
      return { shouldHold: true, reason: 'Funding overlay disabled or no data' };
    }

    const result = this.analyze(currentRate, historicalRates, direction);

    // If funding becomes extremely unfavorable, consider exiting
    if (result.action === 'BLOCK') {
      return {
        shouldHold: false,
        reason: `Extreme unfavorable funding: ${result.reason}`,
      };
    }

    // If just tightening, still hold but trailing should be active
    return { shouldHold: true, reason: result.reason };
  }

  /**
   * Get current configuration
   */
  getConfig(): FundingOverlayConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<FundingOverlayConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}
