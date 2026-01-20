import { Injectable } from '@nestjs/common';
import { HOUR_SWING_CONFIG } from '../../constants/hour-swing.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { BinanceService } from '../data/binance.service';

/**
 * Funding Extremes Detector
 * Counter-trend strategy based on extreme funding rates
 */
@Injectable()
export class FundingExtremesDetectorService {
  private readonly config = HOUR_SWING_CONFIG.subStrategies.fundingExtremes;
  private fundingHistory: Map<string, number[]> = new Map();
  private isInitialized = false;

  // Cache for active funding extremes (for 1m entry checking)
  private activeExtremes: Map<string, {
    direction: TradeDirection;
    zScore: number;
    fundingRate: number;
    lastUpdated: number;
  }> = new Map();

  constructor(
    private readonly logger: CustomLoggerService,
    private readonly binanceService: BinanceService,
  ) {}

  async detect(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
    currentFunding: number,
  ): Promise<TradingSignal> {
    if (!this.config.enabled) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[FundingExtremes] ${symbol} Starting analysis (funding=${(currentFunding * 100).toFixed(4)}%)`,
      'FundingExtremesDetector',
    );

    // 1. Update funding history
    this.updateFundingHistory(symbol, currentFunding);

    // 2. Check if funding is extreme
    const extremeCheck = this.checkFundingExtreme(symbol, currentFunding);

    this.logger.debug(
      `[FundingExtremes] ${symbol} Extreme check: isExtreme=${extremeCheck.isExtreme}, ` +
        `direction=${extremeCheck.direction}, zScore=${extremeCheck.zScore.toFixed(2)}`,
      'FundingExtremesDetector',
    );

    if (!extremeCheck.isExtreme) {
      return { detected: false } as any;
    }

    this.logger.log(
      `[FundingExtremes] ${symbol} 💥 Extreme funding detected! ` +
        `Rate=${(currentFunding * 100).toFixed(4)}%, zScore=${extremeCheck.zScore.toFixed(2)} ` +
        `→ Counter ${extremeCheck.direction}`,
      'FundingExtremesDetector',
    );

    // Cache the extreme for 1m entry checking
    this.activeExtremes.set(symbol, {
      direction: extremeCheck.direction,
      zScore: extremeCheck.zScore,
      fundingRate: currentFunding,
      lastUpdated: Date.now(),
    });

    // 3. Check for momentum slowing (key confirmation)
    const momentumSlowing = this.checkMomentumSlowing(candles, symbol);

    this.logger.debug(
      `[FundingExtremes] ${symbol} Momentum slowing: ${momentumSlowing}`,
      'FundingExtremesDetector',
    );

    if (!momentumSlowing) {
      return { detected: false } as any;
    }

    // 4. Market Structure Check (Contrarian Confirmation)
    // Confirm price is at reversal zone (near highs for SHORT, near lows for LONG)
    // This ensures we're entering at the extreme where reversals happen
    // EXCEPTION: If |zScore| >= 10, allow immediate entry (extreme funding override)
    const structureBreak = this.checkMarketStructureBreak(candles, extremeCheck.direction, symbol);

    this.logger.debug(
      `[FundingExtremes] ${symbol} Market structure (Contrarian): atReversalZone=${structureBreak.broken}` +
        (structureBreak.breakPrice ? `, referencePrice=${structureBreak.breakPrice.toFixed(2)}` : ''),
      'FundingExtremesDetector',
    );

    const extremeZScore = Math.abs(extremeCheck.zScore) >= 10;

    if (extremeZScore) {
      this.logger.log(
        `[FundingExtremes] ${symbol} 🔥 EXTREME zScore detected (${extremeCheck.zScore.toFixed(2)})! ` +
          `Bypassing reversal zone requirement (funding so extreme, enter immediately)`,
        'FundingExtremesDetector',
      );
    } else {
      // Normal case: require price at reversal zone
      if (extremeCheck.direction === TradeDirection.SHORT && !structureBreak.broken) {
        // For shorts, require price near recent highs (reversal zone)
        this.logger.debug(
          `[FundingExtremes] ${symbol} Price not at reversal zone for SHORT (need price >= 98% of recent high)`,
          'FundingExtremesDetector',
        );
        return { detected: false } as any;
      }
      if (extremeCheck.direction === TradeDirection.LONG && !structureBreak.broken) {
        // For longs, require price near recent lows (reversal zone)
        this.logger.debug(
          `[FundingExtremes] ${symbol} Price not at reversal zone for LONG (need price <= 102% of recent low)`,
          'FundingExtremesDetector',
        );
        return { detected: false } as any;
      }
    }

    // 5. RSI confirmation
    const rsi = Indicators.calculateRsi(candles, 14);
    const rsiExtreme = extremeCheck.direction === 'SHORT'
      ? rsi >= this.config.rsiOverbought
      : rsi <= this.config.rsiOversold;

    this.logger.debug(
      `[FundingExtremes] ${symbol} RSI check: ${rsi.toFixed(2)} ` +
        `(extreme=${rsiExtreme}, threshold=${extremeCheck.direction === 'SHORT' ? this.config.rsiOverbought : this.config.rsiOversold})`,
      'FundingExtremesDetector',
    );

    if (this.config.confirmationRequired && !rsiExtreme) {
      return { detected: false } as any;
    }

    // 5. Calculate TP/SL
    // Counter-trend: if funding is extremely positive, go SHORT (expect reversion)
    const direction = extremeCheck.direction;
    const atr = Indicators.calculateAtr(candles, 14);
    const slDistance = atr * this.config.tpSl.slAtrMultiple;

    const slPrice = direction === TradeDirection.LONG
      ? currentPrice - slDistance
      : currentPrice + slDistance;

    const tp1Price = direction === TradeDirection.LONG
      ? currentPrice + slDistance * this.config.tpSl.tp1RR
      : currentPrice - slDistance * this.config.tpSl.tp1RR;

    const tp2Price = direction === TradeDirection.LONG
      ? currentPrice + slDistance * this.config.tpSl.tp2RR
      : currentPrice - slDistance * this.config.tpSl.tp2RR;

    this.logger.log(
      `[FundingExtremes] ${symbol} ✅ Signal generated! ` +
        `Direction=${direction}, Entry=${currentPrice.toFixed(2)}, ` +
        `SL=${slPrice.toFixed(2)}, TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
        `Funding=${(currentFunding * 100).toFixed(4)}%, zScore=${extremeCheck.zScore.toFixed(2)}`,
      'FundingExtremesDetector',
    );

    return {
      detected: true,
      strategyType: StrategyType.HOUR_SWING,
      subStrategy: 'funding_extremes',
      symbol,
      direction,
      entryPrice: currentPrice,
      slPrice,
      tp1Price,
      tp2Price,
      useTrailing: false,
      confidence: 75,
      riskRewardRatio: this.config.tpSl.tp2RR,
      metadata: {
        atr,
        rsi,
        fundingRate: currentFunding,
        fundingZScore: extremeCheck.zScore,
        atReversalZone: structureBreak.broken, // Contrarian: near high (SHORT) or low (LONG)
        reversalReferencePrice: structureBreak.breakPrice,
      },
    };
  }

  /**
   * Check for Market Structure (Contrarian Logic)
   * REVERSED FOR FUNDING EXTREMES STRATEGY (Counter-trend)
   *
   * For SHORTS (Long funding extreme): Price near recent swing HIGH (overbought reversal)
   * For LONGS (Short funding extreme): Price near recent swing LOW (oversold reversal)
   *
   * This is OPPOSITE of trend-following - we enter when price has moved to extreme
   */
  private checkMarketStructureBreak(candles: Candle[], direction: TradeDirection, symbol: string): {
    broken: boolean;
    breakPrice?: number;
  } {
    if (candles.length < 20) {
      return { broken: false };
    }

    // Find swing points in recent candles
    const swingPoints = Indicators.findSwingPoints(candles, 5);
    const currentPrice = candles[candles.length - 1].close;

    if (direction === TradeDirection.SHORT) {
      // For SHORT (long funding extreme): Check if price is NEAR recent swing HIGH
      // This confirms we're at the top where longs are piling in (reversal zone)
      if (swingPoints.highs.length < 2) {
        return { broken: false };
      }

      // Get the most recent swing highs
      const recentHighs = swingPoints.highs.slice(-3).map(idx => candles[idx].high);
      const highestHigh = Math.max(...recentHighs);

      // Price should be within 2% of the highest high (near resistance)
      const nearHighThreshold = highestHigh * 0.98; // 98% of high

      this.logger.debug(
        `[FundingExtremes] ${symbol} Structure check (SHORT - Contrarian): ` +
          `currentPrice=${currentPrice.toFixed(2)}, highestHigh=${highestHigh.toFixed(2)}, ` +
          `threshold=${nearHighThreshold.toFixed(2)} (need >= 98% of high)`,
        'FundingExtremesDetector',
      );

      // Check if current price is near the highest swing high (reversal zone)
      if (currentPrice >= nearHighThreshold) {
        return { broken: true, breakPrice: highestHigh };
      }
    } else {
      // For LONG (short funding extreme): Check if price is NEAR recent swing LOW
      // This confirms we're at the bottom where shorts are piling in (reversal zone)
      if (swingPoints.lows.length < 2) {
        return { broken: false };
      }

      // Get the most recent swing lows
      const recentLows = swingPoints.lows.slice(-3).map(idx => candles[idx].low);
      const lowestLow = Math.min(...recentLows);

      // Price should be within 2% of the lowest low (near support)
      const nearLowThreshold = lowestLow * 1.02; // 102% of low

      this.logger.debug(
        `[FundingExtremes] ${symbol} Structure check (LONG - Contrarian): ` +
          `currentPrice=${currentPrice.toFixed(2)}, lowestLow=${lowestLow.toFixed(2)}, ` +
          `threshold=${nearLowThreshold.toFixed(2)} (need <= 102% of low)`,
        'FundingExtremesDetector',
      );

      // Check if current price is near the lowest swing low (reversal zone)
      if (currentPrice <= nearLowThreshold) {
        return { broken: true, breakPrice: lowestLow };
      }
    }

    return { broken: false };
  }

  /**
   * Update funding history for a symbol
   */
  /**
   * Initialize funding history from Binance API
   * Loads past 168 hours (7 days) of funding rate data for all symbols
   */
  async initializeFundingHistory(symbols: string[]): Promise<void> {
    if (this.isInitialized) {
      this.logger.log('[FundingExtremes] Already initialized, skipping', 'FundingExtremesDetector');
      return;
    }

    this.logger.log(
      `[FundingExtremes] Initializing funding history for ${symbols.length} symbols...`,
      'FundingExtremesDetector'
    );

    let successCount = 0;
    let failCount = 0;

    for (const symbol of symbols) {
      try {
        const history = await this.binanceService.getFundingRateHistory(
          symbol,
          this.config.fundingHistoryPeriod
        );

        if (history.length > 0) {
          this.fundingHistory.set(symbol, history);
          successCount++;

          if (successCount % 10 === 0) {
            this.logger.debug(
              `[FundingExtremes] Loaded ${successCount}/${symbols.length} symbols...`,
              'FundingExtremesDetector'
            );
          }
        } else {
          failCount++;
        }
      } catch (error) {
        this.logger.warn(
          `[FundingExtremes] Failed to load funding history for ${symbol}: ${error.message}`,
          'FundingExtremesDetector'
        );
        failCount++;
      }

      // Rate limiting: Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.isInitialized = true;
    this.logger.log(
      `[FundingExtremes] ✅ Initialization complete: ${successCount} success, ${failCount} failed`,
      'FundingExtremesDetector'
    );
  }

  private updateFundingHistory(symbol: string, funding: number): void {
    if (!this.fundingHistory.has(symbol)) {
      this.fundingHistory.set(symbol, []);
    }

    const history = this.fundingHistory.get(symbol)!;
    history.push(funding);

    // Keep only recent history
    if (history.length > this.config.fundingHistoryPeriod) {
      history.shift();
    }
  }

  /**
   * Check if funding is at extreme levels
   */
  private checkFundingExtreme(symbol: string, currentFunding: number): {
    isExtreme: boolean;
    direction: TradeDirection;
    zScore: number;
  } {
    const history = this.fundingHistory.get(symbol);
    if (!history || history.length < 24) {
      return { isExtreme: false, direction: TradeDirection.LONG, zScore: 0 };
    }

    // Calculate Z-score
    const zScore = Indicators.calculateZScore(currentFunding, history);

    // Check absolute extremes
    const absoluteExtreme =
      currentFunding >= this.config.extremeHighAbsolute ||
      currentFunding <= this.config.extremeLowAbsolute;

    // Check Z-score extremes
    const zScoreExtreme = Math.abs(zScore) >= this.config.extremeZScore;

    if (absoluteExtreme || zScoreExtreme) {
      // Extremely positive funding -> Market is long-biased -> Go SHORT
      // Extremely negative funding -> Market is short-biased -> Go LONG
      const direction = currentFunding > 0 ? TradeDirection.SHORT : TradeDirection.LONG;
      return { isExtreme: true, direction, zScore };
    }

    return { isExtreme: false, direction: TradeDirection.LONG, zScore };
  }

  /**
   * Check if momentum is slowing (reversal signal)
   */
  private checkMomentumSlowing(candles: Candle[], symbol: string): boolean {
    if (candles.length < this.config.momentumSlowingBars + 5) {
      return false;
    }

    const recentCandles = candles.slice(-this.config.momentumSlowingBars);
    const previousCandles = candles.slice(
      -(this.config.momentumSlowingBars * 2),
      -this.config.momentumSlowingBars,
    );

    // Calculate average candle size (measure of momentum)
    const recentAvgSize = recentCandles.reduce(
      (sum, c) => sum + Math.abs(c.close - c.open),
      0,
    ) / recentCandles.length;

    const previousAvgSize = previousCandles.reduce(
      (sum, c) => sum + Math.abs(c.close - c.open),
      0,
    ) / previousCandles.length;

    const reduction = ((previousAvgSize - recentAvgSize) / previousAvgSize) * 100;

    this.logger.debug(
      `[FundingExtremes] ${symbol} Momentum check: ` +
        `recentAvg=${recentAvgSize.toFixed(2)}, previousAvg=${previousAvgSize.toFixed(2)}, ` +
        `reduction=${reduction.toFixed(1)}% (need 30%)`,
      'FundingExtremesDetector',
    );

    // Momentum is slowing if recent candles are smaller
    return recentAvgSize < previousAvgSize * 0.7; // 30% reduction
  }

  /**
   * Check reversal zone only for active extreme (1분봉용 - 익스트림 재감지 없이 진입만 체크)
   * @returns TradingSignal if reversal zone reached, null otherwise
   */
  async checkReversalZoneOnly(
    symbol: string,
    candles: Candle[],
    currentPrice: number,
  ): Promise<TradingSignal | null> {
    // Get cached extreme
    const extreme = this.getActiveExtreme(symbol);
    if (!extreme) {
      return null;
    }

    this.logger.log(
      `[1M-Entry] ${symbol} Checking reversal zone for active extreme (${extreme.direction}) @ ${currentPrice.toFixed(4)}`,
      'FundingExtremesDetector',
    );

    // Check if price is now in reversal zone
    const structureBreak = this.checkMarketStructureBreak(candles, extreme.direction, symbol);

    // If |zScore| >= 10, allow immediate entry (bypass reversal zone)
    const extremeZScore = Math.abs(extreme.zScore) >= 10;

    if (extremeZScore) {
      this.logger.log(
        `[1M-Entry] ${symbol} 🔥 EXTREME zScore (${extreme.zScore.toFixed(2)}) - immediate entry allowed`,
        'FundingExtremesDetector',
      );
    } else if (!structureBreak.broken) {
      // Normal case: require reversal zone
      this.logger.debug(
        `[1M-Entry] ${symbol} Not at reversal zone yet (need ${extreme.direction === 'SHORT' ? '≥98% of high' : '≤102% of low'})`,
        'FundingExtremesDetector',
      );
      return null;
    }

    // Check momentum slowing
    const momentumSlowing = this.checkMomentumSlowing(candles, symbol);
    if (!momentumSlowing) {
      this.logger.debug(
        `[1M-Entry] ${symbol} Momentum not slowing yet`,
        'FundingExtremesDetector',
      );
      return null;
    }

    // Check RSI
    const rsi = Indicators.calculateRsi(candles, 14);
    const rsiExtreme = extreme.direction === 'SHORT'
      ? rsi >= this.config.rsiOverbought
      : rsi <= this.config.rsiOversold;

    if (this.config.confirmationRequired && !rsiExtreme) {
      this.logger.debug(
        `[1M-Entry] ${symbol} RSI not extreme (${rsi.toFixed(2)})`,
        'FundingExtremesDetector',
      );
      return null;
    }

    // All conditions met! Generate signal
    const atr = Indicators.calculateAtr(candles, 14);
    const slDistance = atr * this.config.tpSl.slAtrMultiple;

    const slPrice = extreme.direction === TradeDirection.LONG
      ? currentPrice - slDistance
      : currentPrice + slDistance;

    const tp1Price = extreme.direction === TradeDirection.LONG
      ? currentPrice + slDistance * this.config.tpSl.tp1RR
      : currentPrice - slDistance * this.config.tpSl.tp1RR;

    const tp2Price = extreme.direction === TradeDirection.LONG
      ? currentPrice + slDistance * this.config.tpSl.tp2RR
      : currentPrice - slDistance * this.config.tpSl.tp2RR;

    this.logger.log(
      `[1M-Entry] ${symbol} ⚡ Funding Extremes 1분봉 진입 신호! ` +
        `${extreme.direction} @ ${currentPrice.toFixed(2)}, ` +
        `zScore=${extreme.zScore.toFixed(2)}, RSI=${rsi.toFixed(1)}`,
      'FundingExtremesDetector',
    );

    // Remove from cache after successful entry
    this.removeActiveExtreme(symbol);

    return {
      detected: true,
      strategyType: StrategyType.HOUR_SWING,
      subStrategy: 'funding_extremes_1m',
      symbol,
      direction: extreme.direction,
      entryPrice: currentPrice,
      slPrice,
      tp1Price,
      tp2Price,
      useTrailing: false,
      confidence: 75,
      riskRewardRatio: this.config.tpSl.tp2RR,
      metadata: {
        atr,
        rsi,
        fundingRate: extreme.fundingRate,
        fundingZScore: extreme.zScore,
        atReversalZone: structureBreak.broken || extremeZScore,
        reversalReferencePrice: structureBreak.breakPrice,
        triggeredBy: '1m-candle',
      },
    };
  }

  /**
   * Check if symbol has an active extreme (1분봉 필터링용)
   */
  hasActiveExtreme(symbol: string): boolean {
    const extreme = this.activeExtremes.get(symbol);
    if (!extreme) return false;

    // Check if cache is stale (older than 2 hours)
    const cacheAge = Date.now() - extreme.lastUpdated;
    if (cacheAge > 2 * 60 * 60 * 1000) {
      this.activeExtremes.delete(symbol);
      return false;
    }

    return true;
  }

  /**
   * Get list of symbols with active extremes (1분봉 필터링용)
   */
  getActiveExtremeSymbols(): string[] {
    return Array.from(this.activeExtremes.keys());
  }

  /**
   * Get active extreme from cache
   */
  private getActiveExtreme(symbol: string) {
    const extreme = this.activeExtremes.get(symbol);
    if (!extreme) return null;

    // Check if cache is stale
    const cacheAge = Date.now() - extreme.lastUpdated;
    if (cacheAge > 2 * 60 * 60 * 1000) {
      this.activeExtremes.delete(symbol);
      return null;
    }

    return extreme;
  }

  /**
   * Remove active extreme from cache
   */
  private removeActiveExtreme(symbol: string): void {
    this.activeExtremes.delete(symbol);
  }

  /**
   * Clear old history (cleanup)
   */
  clearOldHistory(): void {
    const maxAge = this.config.fundingHistoryPeriod * 2;
    for (const [symbol, history] of this.fundingHistory.entries()) {
      if (history.length > maxAge) {
        history.splice(0, history.length - maxAge);
      }
    }
  }
}
