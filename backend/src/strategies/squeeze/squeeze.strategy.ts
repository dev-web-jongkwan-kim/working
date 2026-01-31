import {
  IStrategy,
  IDataProvider,
  TradingSignal,
  TradeDirection,
  Candle,
} from '../core/interfaces';
import {
  calculateATR,
  calculateBBWidthPercentile,
  calculateBollingerBands,
  detectBBCompression,
} from '../core/indicators';
import { analyzeFunding, adjustForFunding } from '../core/indicators';
import { SQUEEZE_CONFIG, SqueezeConfig } from './squeeze.config';

/**
 * Squeeze Strategy
 *
 * Volatility compression → expansion breakout strategy based on:
 * - 1H Bollinger Band compression detection
 * - 15m breakout confirmation
 *
 * Entry conditions:
 * 1. 1H BBWidth in lowest percentile (compression)
 * 2. 15m price breaks above/below compression box
 * 3. Close confirmation (not just wick)
 *
 * Exit:
 * - Initial SL: Box opposite edge + buffer
 * - TP1 at 1R: Close 25%
 * - Trail remaining at 2.2 ATR
 */
export class SqueezeStrategy implements IStrategy {
  readonly name = 'SQUEEZE';
  private config: SqueezeConfig;

  constructor(config: Partial<SqueezeConfig> = {}) {
    this.config = { ...SQUEEZE_CONFIG, ...config };
  }

  getSignalTimeframe(): string {
    return this.config.timeframes.detect;
  }

  getEntryTimeframe(): string {
    return this.config.timeframes.entry;
  }

  /**
   * Generate trading signal
   */
  generateSignal(symbol: string, dataProvider: IDataProvider): TradingSignal | null {
    // Get candles for both timeframes
    const candles1h = dataProvider.getCandles(symbol, '1h', 150);
    const candles15m = dataProvider.getCandles(symbol, '15m', 100);

    if (candles1h.length < this.config.compression.compressLookback1h) {
      return null;
    }

    if (candles15m.length < this.config.breakout.breakoutLookback15m) {
      return null;
    }

    // Step 1: Detect compression on 1H
    const compressionAnalysis = this.detectCompression(candles1h);
    if (!compressionAnalysis.isCompressed) {
      return null;
    }

    // Step 2: Detect breakout on 15m
    const breakoutAnalysis = this.detectBreakout(
      candles15m,
      compressionAnalysis.boxHigh,
      compressionAnalysis.boxLow,
    );
    if (!breakoutAnalysis.hasBreakout) {
      return null;
    }

    // Step 3: Calculate trade parameters
    const currentPrice = dataProvider.getCurrentPrice(symbol);
    if (!currentPrice) {
      return null;
    }

    const atr1h = calculateATR(candles1h, this.config.exit.atrLen1h);
    if (!atr1h) {
      return null;
    }

    // Step 4: Check funding overlay
    const fundingRate = dataProvider.getFundingRate(symbol);
    const fundingHistory = dataProvider.getFundingHistory(symbol, 200);
    const fundingAnalysis = fundingRate !== null && fundingHistory.length > 50
      ? analyzeFunding(fundingRate, fundingHistory, 0.9, 0.1, false)
      : null;

    // Block trade if funding is extremely unfavorable
    if (fundingAnalysis?.action === 'BLOCK') {
      return null;
    }

    // Calculate SL from box structure
    const slBuffer = atr1h * this.config.exit.slStructureBufferAtrMult;
    const slPrice =
      breakoutAnalysis.direction === 'LONG'
        ? compressionAnalysis.boxLow - slBuffer
        : compressionAnalysis.boxHigh + slBuffer;

    // Calculate TP1
    const riskDistance = Math.abs(currentPrice - slPrice);
    const tp1Distance = riskDistance * this.config.exit.tp1R;
    const tp1Price =
      breakoutAnalysis.direction === 'LONG'
        ? currentPrice + tp1Distance
        : currentPrice - tp1Distance;

    // Adjust for funding if needed
    let tp1QtyPct = this.config.exit.tp1QtyPct;
    let trailAtrMult = this.config.exit.trailAtrMult;

    if (fundingAnalysis?.action === 'TIGHTEN') {
      const adjusted = adjustForFunding(
        fundingAnalysis,
        tp1QtyPct,
        trailAtrMult,
        0.1,
        0.3,
      );
      tp1QtyPct = adjusted.tp1QtyPercent;
      trailAtrMult = adjusted.trailAtrMult;
    }

    // Calculate confidence
    const confidence = this.calculateConfidence(compressionAnalysis, breakoutAnalysis);

    return {
      detected: true,
      strategyType: 'SQUEEZE',
      subStrategy: breakoutAnalysis.breakoutType,
      symbol,
      direction: breakoutAnalysis.direction,
      entryPrice: currentPrice,
      slPrice,
      slAtrMult: this.config.exit.slStructureBufferAtrMult,
      tp1Price,
      tp1QtyPercent: tp1QtyPct,
      trailAtrMult,
      timeStopBars: undefined, // Squeeze uses trailing, not time stop
      fundingAction: fundingAnalysis?.action || 'ALLOW',
      confidence,
      metadata: {
        bbWidth: compressionAnalysis.bbWidth,
        bbWidthPercentile: compressionAnalysis.percentile,
        compressionDetected: true,
        breakoutConfirmed: true,
        boxHigh: compressionAnalysis.boxHigh,
        boxLow: compressionAnalysis.boxLow,
        atr: atr1h,
        atrPercent: atr1h / currentPrice,
        entryQuality: breakoutAnalysis.quality,
        fundingRate: fundingRate || undefined,
        fundingPctl: fundingAnalysis?.percentile,
        leverage: this.config.position.leverage,
        maxMarginUsd: this.config.position.maxMarginUsd,
        signalTime: dataProvider.getCurrentTime(),
      },
    };
  }

  /**
   * Detect compression on 1H timeframe
   */
  private detectCompression(candles1h: Candle[]): {
    isCompressed: boolean;
    percentile: number;
    bbWidth: number;
    boxHigh: number;
    boxLow: number;
    barsInCompression: number;
  } {
    const percentile = calculateBBWidthPercentile(
      candles1h,
      this.config.compression.bbLen1h,
      this.config.compression.compressLookback1h,
      this.config.compression.bbK1h,
    );

    if (percentile === null) {
      return {
        isCompressed: false,
        percentile: 1,
        bbWidth: 0,
        boxHigh: 0,
        boxLow: 0,
        barsInCompression: 0,
      };
    }

    const bb = calculateBollingerBands(
      candles1h,
      this.config.compression.bbLen1h,
      this.config.compression.bbK1h,
    );

    if (!bb) {
      return {
        isCompressed: false,
        percentile,
        bbWidth: 0,
        boxHigh: 0,
        boxLow: 0,
        barsInCompression: 0,
      };
    }

    const isCompressed = percentile <= this.config.compression.compressPercentile;

    // Calculate compression box (range during compression)
    // Use recent candles during compression period
    const compressionLookback = 20; // Last 20 1H candles for box
    const recentCandles = candles1h.slice(-compressionLookback);
    const boxHigh = Math.max(...recentCandles.map((c) => c.high));
    const boxLow = Math.min(...recentCandles.map((c) => c.low));

    // Count bars in compression
    let barsInCompression = 0;
    for (let i = candles1h.length - 1; i >= 0; i--) {
      const sliceCandles = candles1h.slice(0, i + 1);
      const slicePercentile = calculateBBWidthPercentile(
        sliceCandles,
        this.config.compression.bbLen1h,
        this.config.compression.compressLookback1h,
        this.config.compression.bbK1h,
      );

      if (slicePercentile !== null && slicePercentile <= this.config.compression.compressPercentile) {
        barsInCompression++;
      } else {
        break;
      }
    }

    // Require minimum bars in compression
    const validCompression =
      isCompressed && barsInCompression >= this.config.compression.minBarsInCompression;

    return {
      isCompressed: validCompression,
      percentile,
      bbWidth: bb.widthPercent,
      boxHigh,
      boxLow,
      barsInCompression,
    };
  }

  /**
   * Detect breakout on 15m timeframe
   */
  private detectBreakout(
    candles15m: Candle[],
    boxHigh: number,
    boxLow: number,
  ): {
    hasBreakout: boolean;
    direction: TradeDirection;
    breakoutType: string;
    quality: 'HIGH' | 'MEDIUM' | 'LOW';
  } {
    const currentCandle = candles15m[candles15m.length - 1];
    const previousCandle = candles15m[candles15m.length - 2];

    // Check for close breakout (if required)
    const closeAboveBox = this.config.breakout.requireCloseBreak
      ? currentCandle.close > boxHigh
      : currentCandle.high > boxHigh;

    const closeBelowBox = this.config.breakout.requireCloseBreak
      ? currentCandle.close < boxLow
      : currentCandle.low < boxLow;

    // No breakout
    if (!closeAboveBox && !closeBelowBox) {
      return {
        hasBreakout: false,
        direction: 'LONG',
        breakoutType: '',
        quality: 'LOW',
      };
    }

    const direction: TradeDirection = closeAboveBox ? 'LONG' : 'SHORT';

    // Determine breakout quality
    let quality: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
    let breakoutType = 'BREAKOUT';

    // Check volume confirmation
    const avgVolume =
      candles15m.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
    const volumeRatio = currentCandle.volume / avgVolume;

    // Check momentum (candle body vs range)
    const bodySize = Math.abs(currentCandle.close - currentCandle.open);
    const rangeSize = currentCandle.high - currentCandle.low;
    const bodyRatio = rangeSize > 0 ? bodySize / rangeSize : 0;

    // High quality: Strong volume + clean candle body
    if (volumeRatio >= 1.5 && bodyRatio >= 0.6) {
      quality = 'HIGH';
      breakoutType = 'STRONG_BREAKOUT';
    } else if (volumeRatio >= 1.0 && bodyRatio >= 0.4) {
      quality = 'MEDIUM';
      breakoutType = 'CLEAN_BREAKOUT';
    }

    // Check for false breakout signals (wicks with no close)
    if (direction === 'LONG') {
      // Previous candle closed above box but current closed inside
      if (previousCandle.close > boxHigh && currentCandle.close < boxHigh) {
        return {
          hasBreakout: false,
          direction,
          breakoutType: 'FALSE_BREAKOUT',
          quality: 'LOW',
        };
      }
    } else {
      if (previousCandle.close < boxLow && currentCandle.close > boxLow) {
        return {
          hasBreakout: false,
          direction,
          breakoutType: 'FALSE_BREAKOUT',
          quality: 'LOW',
        };
      }
    }

    // Handle retest mode
    if (this.config.breakout.retestMode === 'required') {
      // Check if price retested the breakout level
      const hasRetest = direction === 'LONG'
        ? previousCandle.low <= boxHigh && currentCandle.close > boxHigh
        : previousCandle.high >= boxLow && currentCandle.close < boxLow;

      if (!hasRetest) {
        return {
          hasBreakout: false,
          direction,
          breakoutType: 'WAITING_RETEST',
          quality: 'LOW',
        };
      }

      breakoutType = 'RETEST_BREAKOUT';
      if (quality !== 'LOW') quality = 'HIGH';
    }

    return {
      hasBreakout: true,
      direction,
      breakoutType,
      quality,
    };
  }

  /**
   * Calculate signal confidence
   */
  private calculateConfidence(
    compressionAnalysis: ReturnType<typeof this.detectCompression>,
    breakoutAnalysis: ReturnType<typeof this.detectBreakout>,
  ): number {
    let confidence = 50; // Base confidence

    // Compression quality (0-20)
    // Lower percentile = tighter compression = higher confidence
    const compressionScore = (1 - compressionAnalysis.percentile) * 20;
    confidence += compressionScore;

    // Bars in compression (0-10)
    const compressionBars = Math.min(compressionAnalysis.barsInCompression / 10, 1) * 10;
    confidence += compressionBars;

    // Breakout quality (0-20)
    if (breakoutAnalysis.quality === 'HIGH') confidence += 20;
    else if (breakoutAnalysis.quality === 'MEDIUM') confidence += 10;

    return Math.min(Math.round(confidence), 100);
  }
}
