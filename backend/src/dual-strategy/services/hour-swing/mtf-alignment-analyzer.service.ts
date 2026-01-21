import { Injectable } from '@nestjs/common';
import { HOUR_SWING_CONFIG } from '../../constants/hour-swing.config';
import { Candle } from '../../interfaces/candle.interface';
import { TradingSignal } from '../../interfaces/signal.interface';
import { Indicators } from '../../utils/indicators';
import { CandleAnalyzer } from '../../utils/candle-analyzer';
import { StrategyType, TradeDirection } from '../../../entities/trade.entity';
import { DataCacheService } from '../data/data-cache.service';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

/**
 * MTF Alignment Analyzer (Multi-Timeframe)
 * Analyzes 1H, 15M, 5M alignment with pullback entry
 * CRITICAL: Uses consecutive bar filter to avoid late entry
 */
@Injectable()
export class MtfAlignmentAnalyzerService {
  private readonly config = HOUR_SWING_CONFIG.subStrategies.mtfAlignment;

  constructor(
    private readonly cacheService: DataCacheService,
    private readonly logger: CustomLoggerService,
  ) {}

  async analyze(symbol: string, currentPrice: number, fundingRate: number): Promise<TradingSignal> {
    if (!this.config.enabled) {
      return { detected: false } as any;
    }

    this.logger.debug(
      `[MTF Alignment] ${symbol} Starting analysis (price=${currentPrice.toFixed(2)}, funding=${(fundingRate * 100).toFixed(4)}%)`,
      'MtfAlignmentAnalyzer',
    );

    // Get candles for all timeframes
    const h1Candles = await this.cacheService.getRecentCandles(symbol, '1h', 24);
    const m15Candles = await this.cacheService.getRecentCandles(symbol, '15m', 20);
    const m5Candles = await this.cacheService.getRecentCandles(symbol, '5m', 30);

    if (!h1Candles || !m15Candles || !m5Candles) {
      return { detected: false } as any;
    }

    if (h1Candles.length < 6 || m15Candles.length < 4 || m5Candles.length < 10) {
      return { detected: false } as any;
    }

    // 1. Analyze 1H trend
    const h1Analysis = this.analyze1H(h1Candles);

    this.logger.debug(
      `[MTF Alignment] ${symbol} 1H analysis: valid=${h1Analysis.valid}, ` +
        `direction=${h1Analysis.direction}, strength=${h1Analysis.strength.toFixed(2)} ` +
        `(min=${this.config.h1.minStrength}, max=${this.config.h1.maxStrength})`,
      'MtfAlignmentAnalyzer',
    );

    if (!h1Analysis.valid || h1Analysis.direction === 'NEUTRAL') {
      return { detected: false } as any;
    }

    // ★ CRITICAL: Check consecutive bars on 1H (avoid late entry)
    const h1ConsecutiveBars = CandleAnalyzer.countConsecutiveBars(
      h1Candles.slice(-6),
      h1Analysis.direction as 'UP' | 'DOWN',
    );

    this.logger.debug(
      `[MTF Alignment] ${symbol} 1H consecutive bars: ${h1ConsecutiveBars}/${this.config.h1.maxConsecutiveBars} ` +
        `(${h1ConsecutiveBars > this.config.h1.maxConsecutiveBars ? '❌ Too late' : '✅ Early entry'})`,
      'MtfAlignmentAnalyzer',
    );

    if (h1ConsecutiveBars > this.config.h1.maxConsecutiveBars) {
      return { detected: false } as any; // Too late!
    }

    // 2. Analyze 15M trend (must align with 1H)
    const m15Analysis = this.analyze15M(m15Candles, h1Analysis.direction);

    this.logger.debug(
      `[MTF Alignment] ${symbol} 15M analysis: aligned=${m15Analysis.aligned}, ` +
        `strength=${m15Analysis.strength.toFixed(2)} (expected direction: ${h1Analysis.direction})`,
      'MtfAlignmentAnalyzer',
    );

    if (!m15Analysis.aligned) {
      return { detected: false } as any;
    }

    // 3. Analyze 5M pullback
    const m5Analysis = this.analyze5M(m5Candles, h1Analysis.direction);

    this.logger.debug(
      `[MTF Alignment] ${symbol} 5M pullback: detected=${m5Analysis.isPullback}, ` +
        `depth=${m5Analysis.pullbackDepth.toFixed(2)} ATR ` +
        `(min=${this.config.m5.minPullbackDepthAtr}, max=${this.config.m5.maxPullbackDepthAtr})`,
      'MtfAlignmentAnalyzer',
    );

    if (!m5Analysis.isPullback) {
      return { detected: false } as any;
    }

    // 4. EMA filter
    if (this.config.emaFilter.enabled) {
      const emaAligned = this.checkEmaAlignment(h1Candles, h1Analysis.direction);

      this.logger.debug(
        `[MTF Alignment] ${symbol} EMA filter: aligned=${emaAligned} (direction: ${h1Analysis.direction})`,
        'MtfAlignmentAnalyzer',
      );

      if (!emaAligned) {
        return { detected: false } as any;
      }
    }

    // 5. Funding filter
    const fundingOk = this.checkFunding(fundingRate, h1Analysis.direction);

    this.logger.debug(
      `[MTF Alignment] ${symbol} Funding filter: ok=${fundingOk}, rate=${(fundingRate * 100).toFixed(4)}% ` +
        `(direction: ${h1Analysis.direction})`,
      'MtfAlignmentAnalyzer',
    );

    if (!fundingOk) {
      return { detected: false } as any;
    }

    // 6. NEW: RSI 모멘텀 반전 필터 (과매수/과매도 진입 방지)
    if (this.config.rsiFilter?.enabled) {
      const rsi = Indicators.calculateRsi(m15Candles, this.config.rsiFilter.period);
      const rsiCheck = this.checkRsiFilter(rsi, h1Analysis.direction);

      this.logger.debug(
        `[MTF Alignment] ${symbol} RSI filter: ok=${rsiCheck.ok}, RSI=${rsi.toFixed(1)} ` +
          `(direction: ${h1Analysis.direction}, threshold: ${rsiCheck.threshold})`,
        'MtfAlignmentAnalyzer',
      );

      if (!rsiCheck.ok) {
        this.logger.log(
          `[MTF Alignment] ${symbol} ❌ RSI filter blocked: RSI=${rsi.toFixed(1)} ${rsiCheck.reason}`,
          'MtfAlignmentAnalyzer',
        );
        return { detected: false } as any;
      }
    }

    // 7. Calculate TP/SL (Fixed R/R 1:1.8)
    const direction = h1Analysis.direction === 'UP' ? TradeDirection.LONG : TradeDirection.SHORT;
    const m5Atr = Indicators.calculateAtr(m5Candles, 14);

    let slDistance = Math.max(
      m5Atr * this.config.tpSl.slAtrMultiple,
      currentPrice * this.config.tpSl.minSlPercent,
    );
    slDistance = Math.min(slDistance, currentPrice * this.config.tpSl.maxSlPercent);

    const slPrice = direction === TradeDirection.LONG
      ? currentPrice - slDistance
      : currentPrice + slDistance;

    const tp1Distance = slDistance * this.config.tpSl.tp1RR;
    const tp2Distance = slDistance * this.config.tpSl.tp2RR;

    const tp1Price = direction === TradeDirection.LONG
      ? currentPrice + tp1Distance
      : currentPrice - tp1Distance;

    const tp2Price = direction === TradeDirection.LONG
      ? currentPrice + tp2Distance
      : currentPrice - tp2Distance;

    this.logger.log(
      `[MTF Alignment] ${symbol} ✅ Signal generated! ` +
        `Direction=${direction}, Entry=${currentPrice.toFixed(2)}, ` +
        `SL=${slPrice.toFixed(2)}, TP1=${tp1Price.toFixed(2)}, TP2=${tp2Price.toFixed(2)}, ` +
        `R:R=${this.config.tpSl.tp2RR}, ` +
        `H1 strength=${h1Analysis.strength.toFixed(2)}, consecutive=${h1ConsecutiveBars}`,
      'MtfAlignmentAnalyzer',
    );

    return {
      detected: true,
      strategyType: StrategyType.HOUR_SWING,
      subStrategy: 'mtf_alignment',
      symbol,
      direction,
      entryPrice: currentPrice,
      slPrice,
      tp1Price,
      tp2Price,
      useTrailing: false,
      confidence: 70,
      riskRewardRatio: this.config.tpSl.tp2RR,
      metadata: {
        atr: m5Atr,
        h1Strength: h1Analysis.strength,
        h1ConsecutiveBars,
        m15Strength: m15Analysis.strength,
        m5PullbackDepth: m5Analysis.pullbackDepth,
        fundingRate,
      },
    };
  }

  /**
   * Analyze 1H timeframe
   */
  private analyze1H(candles: Candle[]): {
    valid: boolean;
    direction: 'UP' | 'DOWN' | 'NEUTRAL';
    strength: number;
  } {
    const trend = CandleAnalyzer.calculateTrendStrength(candles.slice(-this.config.h1.trendBars));

    // Strength must be in early trend range (0.15-0.5)
    if (
      trend.strength < this.config.h1.minStrength ||
      trend.strength > this.config.h1.maxStrength
    ) {
      return { valid: false, direction: 'NEUTRAL', strength: 0 };
    }

    if (trend.direction === 'NEUTRAL') {
      return { valid: false, direction: 'NEUTRAL', strength: 0 };
    }

    return { valid: true, direction: trend.direction, strength: trend.strength };
  }

  /**
   * Analyze 15M timeframe (must align with 1H)
   */
  private analyze15M(
    candles: Candle[],
    h1Direction: 'UP' | 'DOWN' | 'NEUTRAL',
  ): { aligned: boolean; strength: number } {
    const trend = CandleAnalyzer.calculateTrendStrength(candles.slice(-this.config.m15.trendBars));

    if (this.config.m15.mustAlignWithH1 && trend.direction !== h1Direction) {
      return { aligned: false, strength: 0 };
    }

    if (trend.strength < this.config.m15.minStrength || trend.strength > this.config.m15.maxStrength) {
      return { aligned: false, strength: 0 };
    }

    return { aligned: true, strength: trend.strength };
  }

  /**
   * Analyze 5M pullback
   */
  private analyze5M(
    candles: Candle[],
    h1Direction: 'UP' | 'DOWN' | 'NEUTRAL',
  ): { isPullback: boolean; pullbackDepth: number } {
    if (h1Direction === 'NEUTRAL') {
      return { isPullback: false, pullbackDepth: 0 };
    }

    const atr = Indicators.calculateAtr(candles, 14);
    const pullback = CandleAnalyzer.isPullback(candles, h1Direction as 'UP' | 'DOWN', {
      minDepthAtr: this.config.m5.minPullbackDepthAtr,
      maxDepthAtr: this.config.m5.maxPullbackDepthAtr,
      atr,
    });

    if (!pullback.isPullback) {
      return { isPullback: false, pullbackDepth: 0 };
    }

    // CVD confirmation
    const cvdValues = Indicators.calculateCvd(candles.slice(-this.config.m5.cvdConfirmBars - 2));
    const recentCvd = cvdValues.slice(-this.config.m5.cvdConfirmBars);
    const cvdSum = recentCvd.reduce((a, b) => a + b, 0);
    const cvdConfirm = h1Direction === 'UP' ? cvdSum > 0 : cvdSum < 0;

    if (!cvdConfirm) {
      return { isPullback: false, pullbackDepth: 0 };
    }

    return { isPullback: true, pullbackDepth: pullback.depth };
  }

  /**
   * Check EMA alignment
   */
  private checkEmaAlignment(candles: Candle[], direction: 'UP' | 'DOWN' | 'NEUTRAL'): boolean {
    const closes = candles.map((c) => c.close);
    const ema7 = Indicators.calculateEma(closes, this.config.emaFilter.ema7Period);
    const ema20 = Indicators.calculateEma(closes, this.config.emaFilter.ema20Period);

    if (ema7.length === 0 || ema20.length === 0) {
      return false;
    }

    const ema7Current = ema7[ema7.length - 1];
    const ema20Current = ema20[ema20.length - 1];

    if (direction === 'UP') {
      return ema7Current > ema20Current;
    } else if (direction === 'DOWN') {
      return ema7Current < ema20Current;
    }

    return false;
  }

  /**
   * Check funding rate
   */
  private checkFunding(fundingRate: number, direction: 'UP' | 'DOWN' | 'NEUTRAL'): boolean {
    if (direction === 'UP') {
      // For long, funding should not be too positive (expensive to hold)
      return fundingRate <= this.config.fundingFilter.longMax;
    } else if (direction === 'DOWN') {
      // For short, funding should not be too negative (expensive to hold)
      return fundingRate >= this.config.fundingFilter.shortMin;
    }

    return true;
  }

  /**
   * Check RSI filter to prevent entries when momentum is exhausted
   * - SHORT entry: Block if RSI < oversold threshold (potential reversal up)
   * - LONG entry: Block if RSI > overbought threshold (potential reversal down)
   */
  private checkRsiFilter(
    rsi: number,
    direction: 'UP' | 'DOWN' | 'NEUTRAL',
  ): { ok: boolean; threshold: number; reason?: string } {
    if (direction === 'DOWN') {
      // SHORT entry - block if already oversold (potential bounce)
      if (rsi < this.config.rsiFilter.shortOversoldThreshold) {
        return {
          ok: false,
          threshold: this.config.rsiFilter.shortOversoldThreshold,
          reason: `과매도 구간 (RSI < ${this.config.rsiFilter.shortOversoldThreshold}) - SHORT 금지`,
        };
      }
    } else if (direction === 'UP') {
      // LONG entry - block if already overbought (potential drop)
      if (rsi > this.config.rsiFilter.longOverboughtThreshold) {
        return {
          ok: false,
          threshold: this.config.rsiFilter.longOverboughtThreshold,
          reason: `과매수 구간 (RSI > ${this.config.rsiFilter.longOverboughtThreshold}) - LONG 금지`,
        };
      }
    }

    return { ok: true, threshold: 0 };
  }
}
