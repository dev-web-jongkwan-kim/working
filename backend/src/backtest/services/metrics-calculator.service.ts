/**
 * Extended Metrics Calculator Service
 *
 * Calculates comprehensive risk and performance metrics for backtesting:
 * - Basic: Sharpe, Win Rate, Profit Factor
 * - Risk: Sortino, Calmar, VaR, CVaR, Ulcer Index
 * - Drawdown: Max DD, Avg DD, Recovery Time
 * - Streak: Max Consecutive Wins/Losses
 * - Time: Average Holding Period, Recovery Factor
 */

import { Injectable } from '@nestjs/common';

export interface TradeResult {
  pnlUsd: number;
  pnlPercent: number;
  entryTime: Date;
  exitTime: Date;
  isWin: boolean;
  symbol?: string;
  strategy?: string;
  marketRegime?: string;
}

export interface BasicMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnlUsd: number;
  totalPnlPercent: number;
  avgPnlUsd: number;
  avgWinUsd: number;
  avgLossUsd: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
}

export interface RiskMetrics {
  /** Sharpe Ratio (annualized) */
  sharpeRatio: number;

  /** Sortino Ratio - only considers downside volatility */
  sortinoRatio: number;

  /** Calmar Ratio - annualized return / max drawdown */
  calmarRatio: number;

  /** Value at Risk (95%) - max expected loss in 95% of cases */
  var95: number;

  /** Conditional VaR (Expected Shortfall) - avg loss beyond VaR */
  cvar95: number;

  /** Value at Risk (99%) */
  var99: number;

  /** Conditional VaR (99%) */
  cvar99: number;

  /** Ulcer Index - considers drawdown duration */
  ulcerIndex: number;

  /** Standard deviation of returns */
  standardDeviation: number;

  /** Downside deviation (for Sortino) */
  downsideDeviation: number;

  /** Skewness - asymmetry of return distribution */
  skewness: number;

  /** Kurtosis - tail thickness of return distribution */
  kurtosis: number;
}

export interface DrawdownMetrics {
  /** Maximum drawdown percentage */
  maxDrawdownPercent: number;

  /** Maximum drawdown in USD */
  maxDrawdownUsd: number;

  /** Average drawdown percentage */
  avgDrawdownPercent: number;

  /** Maximum drawdown duration in days */
  maxDrawdownDurationDays: number;

  /** Time to recover from max drawdown in days */
  recoveryTimeDays: number;

  /** Recovery factor - total profit / max drawdown */
  recoveryFactor: number;

  /** Number of drawdown periods */
  drawdownCount: number;

  /** Drawdown history for charting */
  drawdownHistory: Array<{
    startDate: Date;
    endDate: Date;
    depth: number;
    durationDays: number;
  }>;
}

export interface StreakMetrics {
  /** Maximum consecutive winning trades */
  maxConsecutiveWins: number;

  /** Maximum consecutive losing trades */
  maxConsecutiveLosses: number;

  /** Maximum consecutive profit (USD) */
  maxWinStreakUsd: number;

  /** Maximum consecutive loss (USD) */
  maxLossStreakUsd: number;

  /** Current streak (positive = wins, negative = losses) */
  currentStreak: number;

  /** Average winning streak length */
  avgWinStreak: number;

  /** Average losing streak length */
  avgLossStreak: number;
}

export interface TimeMetrics {
  /** Average holding period in hours */
  avgHoldingPeriodHours: number;

  /** Maximum holding period in hours */
  maxHoldingPeriodHours: number;

  /** Minimum holding period in hours */
  minHoldingPeriodHours: number;

  /** Standard deviation of holding period */
  holdingPeriodStdDev: number;

  /** Trades per day (average) */
  tradesPerDay: number;

  /** Percentage of time in market */
  timeInMarketPercent: number;
}

export interface ExtendedMetrics {
  basic: BasicMetrics;
  risk: RiskMetrics;
  drawdown: DrawdownMetrics;
  streak: StreakMetrics;
  time: TimeMetrics;

  /** Overall score (0-100) based on combined metrics */
  overallScore: number;

  /** Risk warnings */
  warnings: string[];

  /** Summary statistics */
  summary: {
    riskAdjustedReturn: number;
    consistencyScore: number;
    robustnessScore: number;
  };
}

@Injectable()
export class MetricsCalculatorService {
  private readonly ANNUAL_TRADING_DAYS = 365; // Crypto trades 24/7
  private readonly RISK_FREE_RATE = 0.05; // 5% annual risk-free rate

  /**
   * Calculate all extended metrics from trade results
   */
  calculateExtendedMetrics(
    trades: TradeResult[],
    initialBalance: number,
  ): ExtendedMetrics {
    if (trades.length === 0) {
      return this.getEmptyMetrics();
    }

    const basic = this.calculateBasicMetrics(trades);
    const risk = this.calculateRiskMetrics(trades, initialBalance);
    const drawdown = this.calculateDrawdownMetrics(trades, initialBalance);
    const streak = this.calculateStreakMetrics(trades);
    const time = this.calculateTimeMetrics(trades);

    const overallScore = this.calculateOverallScore(basic, risk, drawdown, streak);
    const warnings = this.generateWarnings(basic, risk, drawdown, streak);

    return {
      basic,
      risk,
      drawdown,
      streak,
      time,
      overallScore,
      warnings,
      summary: {
        riskAdjustedReturn: risk.sortinoRatio,
        consistencyScore: this.calculateConsistencyScore(trades),
        robustnessScore: this.calculateRobustnessScore(risk, drawdown),
      },
    };
  }

  /**
   * Calculate basic performance metrics
   */
  calculateBasicMetrics(trades: TradeResult[]): BasicMetrics {
    const winningTrades = trades.filter((t) => t.pnlUsd > 0);
    const losingTrades = trades.filter((t) => t.pnlUsd <= 0);

    const totalPnlUsd = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnlUsd, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlUsd, 0));

    const avgWinUsd = winningTrades.length > 0
      ? grossProfit / winningTrades.length
      : 0;
    const avgLossUsd = losingTrades.length > 0
      ? grossLoss / losingTrades.length
      : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: (winningTrades.length / trades.length) * 100,
      totalPnlUsd,
      totalPnlPercent: trades.reduce((sum, t) => sum + t.pnlPercent, 0),
      avgPnlUsd: totalPnlUsd / trades.length,
      avgWinUsd,
      avgLossUsd,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      grossProfit,
      grossLoss,
    };
  }

  /**
   * Calculate risk metrics including Sortino, Calmar, VaR, CVaR
   */
  calculateRiskMetrics(trades: TradeResult[], initialBalance: number): RiskMetrics {
    const returns = trades.map((t) => t.pnlPercent / 100);
    const n = returns.length;

    if (n === 0) {
      return this.getEmptyRiskMetrics();
    }

    // Mean return
    const meanReturn = returns.reduce((a, b) => a + b, 0) / n;

    // Standard deviation
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / n;
    const stdDev = Math.sqrt(variance);

    // Downside deviation (for Sortino)
    const downsideReturns = returns.filter((r) => r < 0);
    const downsideVariance = downsideReturns.length > 0
      ? downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
      : 0;
    const downsideDeviation = Math.sqrt(downsideVariance);

    // Annualization factor (assuming average trade duration)
    const avgTradeDays = this.calculateAvgTradeDays(trades);
    const tradesPerYear = this.ANNUAL_TRADING_DAYS / Math.max(avgTradeDays, 1);
    const annualizationFactor = Math.sqrt(tradesPerYear);

    // Daily risk-free rate
    const dailyRiskFree = this.RISK_FREE_RATE / this.ANNUAL_TRADING_DAYS;
    const tradeRiskFree = dailyRiskFree * avgTradeDays;

    // Sharpe Ratio (annualized)
    const sharpeRatio = stdDev > 0
      ? ((meanReturn - tradeRiskFree) / stdDev) * annualizationFactor
      : 0;

    // Sortino Ratio (annualized)
    const sortinoRatio = downsideDeviation > 0
      ? ((meanReturn - tradeRiskFree) / downsideDeviation) * annualizationFactor
      : meanReturn > 0 ? Infinity : 0;

    // Value at Risk
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const var95Index = Math.floor(n * 0.05);
    const var99Index = Math.floor(n * 0.01);

    const var95 = sortedReturns[var95Index] || sortedReturns[0];
    const var99 = sortedReturns[var99Index] || sortedReturns[0];

    // Conditional VaR (Expected Shortfall)
    const cvar95 = var95Index > 0
      ? sortedReturns.slice(0, var95Index).reduce((a, b) => a + b, 0) / var95Index
      : var95;
    const cvar99 = var99Index > 0
      ? sortedReturns.slice(0, var99Index).reduce((a, b) => a + b, 0) / var99Index
      : var99;

    // Skewness
    const skewness = n > 2 && stdDev > 0
      ? (n / ((n - 1) * (n - 2))) *
        returns.reduce((sum, r) => sum + Math.pow((r - meanReturn) / stdDev, 3), 0)
      : 0;

    // Kurtosis
    const kurtosis = n > 3 && stdDev > 0
      ? ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) *
          returns.reduce((sum, r) => sum + Math.pow((r - meanReturn) / stdDev, 4), 0) -
        (3 * Math.pow(n - 1, 2)) / ((n - 2) * (n - 3))
      : 0;

    // Ulcer Index (drawdown-based)
    const { ulcerIndex } = this.calculateUlcerIndex(trades, initialBalance);

    // Calmar Ratio
    const annualReturn = meanReturn * tradesPerYear;
    const { maxDrawdownPercent } = this.calculateDrawdownMetrics(trades, initialBalance);
    const calmarRatio = maxDrawdownPercent > 0
      ? (annualReturn * 100) / maxDrawdownPercent
      : annualReturn > 0 ? Infinity : 0;

    return {
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      var95: var95 * 100,
      cvar95: cvar95 * 100,
      var99: var99 * 100,
      cvar99: cvar99 * 100,
      ulcerIndex,
      standardDeviation: stdDev * 100,
      downsideDeviation: downsideDeviation * 100,
      skewness,
      kurtosis,
    };
  }

  /**
   * Calculate drawdown metrics
   */
  calculateDrawdownMetrics(trades: TradeResult[], initialBalance: number): DrawdownMetrics {
    if (trades.length === 0) {
      return this.getEmptyDrawdownMetrics();
    }

    // Build equity curve
    let balance = initialBalance;
    let peak = initialBalance;
    let maxDrawdownUsd = 0;
    let maxDrawdownPercent = 0;
    let currentDrawdownStart: Date | null = null;
    let maxDrawdownDuration = 0;
    let recoveryTime = 0;
    let maxDrawdownEndDate: Date | null = null;

    const drawdowns: Array<{
      startDate: Date;
      endDate: Date;
      depth: number;
      durationDays: number;
    }> = [];

    let currentDrawdown = {
      startDate: trades[0].exitTime,
      depth: 0,
    };

    const equityCurve: Array<{ date: Date; balance: number; drawdown: number }> = [];

    for (const trade of trades) {
      balance += trade.pnlUsd;

      const drawdownUsd = peak - balance;
      const drawdownPercent = (drawdownUsd / peak) * 100;

      equityCurve.push({
        date: trade.exitTime,
        balance,
        drawdown: drawdownPercent,
      });

      if (balance > peak) {
        // New peak - end current drawdown if any
        if (currentDrawdownStart && currentDrawdown.depth > 0) {
          const durationDays = this.daysBetween(currentDrawdownStart, trade.exitTime);
          drawdowns.push({
            startDate: currentDrawdownStart,
            endDate: trade.exitTime,
            depth: currentDrawdown.depth,
            durationDays,
          });

          // Check if this was the max drawdown
          if (currentDrawdown.depth >= maxDrawdownPercent) {
            recoveryTime = durationDays;
          }
        }

        peak = balance;
        currentDrawdownStart = null;
        currentDrawdown = { startDate: trade.exitTime, depth: 0 };
      } else if (drawdownPercent > 0) {
        // In drawdown
        if (!currentDrawdownStart) {
          currentDrawdownStart = trade.exitTime;
          currentDrawdown.startDate = trade.exitTime;
        }

        if (drawdownPercent > currentDrawdown.depth) {
          currentDrawdown.depth = drawdownPercent;
        }

        if (drawdownPercent > maxDrawdownPercent) {
          maxDrawdownPercent = drawdownPercent;
          maxDrawdownUsd = drawdownUsd;
          maxDrawdownEndDate = trade.exitTime;
        }

        const currentDuration = this.daysBetween(currentDrawdownStart, trade.exitTime);
        if (currentDuration > maxDrawdownDuration) {
          maxDrawdownDuration = currentDuration;
        }
      }
    }

    // Handle ongoing drawdown at end
    if (currentDrawdownStart && currentDrawdown.depth > 0) {
      const lastTrade = trades[trades.length - 1];
      const durationDays = this.daysBetween(currentDrawdownStart, lastTrade.exitTime);
      drawdowns.push({
        startDate: currentDrawdownStart,
        endDate: lastTrade.exitTime,
        depth: currentDrawdown.depth,
        durationDays,
      });
    }

    // Calculate average drawdown
    const avgDrawdownPercent = drawdowns.length > 0
      ? drawdowns.reduce((sum, d) => sum + d.depth, 0) / drawdowns.length
      : 0;

    // Recovery factor
    const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
    const recoveryFactor = maxDrawdownUsd > 0 ? totalPnl / maxDrawdownUsd : totalPnl > 0 ? Infinity : 0;

    return {
      maxDrawdownPercent,
      maxDrawdownUsd,
      avgDrawdownPercent,
      maxDrawdownDurationDays: maxDrawdownDuration,
      recoveryTimeDays: recoveryTime,
      recoveryFactor,
      drawdownCount: drawdowns.length,
      drawdownHistory: drawdowns,
    };
  }

  /**
   * Calculate streak metrics
   */
  calculateStreakMetrics(trades: TradeResult[]): StreakMetrics {
    if (trades.length === 0) {
      return this.getEmptyStreakMetrics();
    }

    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let maxWinStreakUsd = 0;
    let maxLossStreakUsd = 0;

    let currentWinStreak = 0;
    let currentLossStreak = 0;
    let currentWinStreakUsd = 0;
    let currentLossStreakUsd = 0;

    const winStreaks: number[] = [];
    const lossStreaks: number[] = [];

    for (const trade of trades) {
      if (trade.pnlUsd > 0) {
        // Win
        currentWinStreak++;
        currentWinStreakUsd += trade.pnlUsd;

        if (currentLossStreak > 0) {
          lossStreaks.push(currentLossStreak);
          if (currentLossStreak > maxConsecutiveLosses) {
            maxConsecutiveLosses = currentLossStreak;
          }
          if (currentLossStreakUsd > maxLossStreakUsd) {
            maxLossStreakUsd = currentLossStreakUsd;
          }
          currentLossStreak = 0;
          currentLossStreakUsd = 0;
        }
      } else {
        // Loss
        currentLossStreak++;
        currentLossStreakUsd += Math.abs(trade.pnlUsd);

        if (currentWinStreak > 0) {
          winStreaks.push(currentWinStreak);
          if (currentWinStreak > maxConsecutiveWins) {
            maxConsecutiveWins = currentWinStreak;
          }
          if (currentWinStreakUsd > maxWinStreakUsd) {
            maxWinStreakUsd = currentWinStreakUsd;
          }
          currentWinStreak = 0;
          currentWinStreakUsd = 0;
        }
      }
    }

    // Handle final streak
    if (currentWinStreak > 0) {
      winStreaks.push(currentWinStreak);
      if (currentWinStreak > maxConsecutiveWins) {
        maxConsecutiveWins = currentWinStreak;
      }
      if (currentWinStreakUsd > maxWinStreakUsd) {
        maxWinStreakUsd = currentWinStreakUsd;
      }
    }
    if (currentLossStreak > 0) {
      lossStreaks.push(currentLossStreak);
      if (currentLossStreak > maxConsecutiveLosses) {
        maxConsecutiveLosses = currentLossStreak;
      }
      if (currentLossStreakUsd > maxLossStreakUsd) {
        maxLossStreakUsd = currentLossStreakUsd;
      }
    }

    const currentStreak = currentWinStreak > 0 ? currentWinStreak : -currentLossStreak;
    const avgWinStreak = winStreaks.length > 0
      ? winStreaks.reduce((a, b) => a + b, 0) / winStreaks.length
      : 0;
    const avgLossStreak = lossStreaks.length > 0
      ? lossStreaks.reduce((a, b) => a + b, 0) / lossStreaks.length
      : 0;

    return {
      maxConsecutiveWins,
      maxConsecutiveLosses,
      maxWinStreakUsd,
      maxLossStreakUsd,
      currentStreak,
      avgWinStreak,
      avgLossStreak,
    };
  }

  /**
   * Calculate time-based metrics
   */
  calculateTimeMetrics(trades: TradeResult[]): TimeMetrics {
    if (trades.length === 0) {
      return this.getEmptyTimeMetrics();
    }

    const holdingPeriods = trades.map((t) => {
      const entryTime = t.entryTime.getTime();
      const exitTime = t.exitTime.getTime();
      return (exitTime - entryTime) / (1000 * 60 * 60); // Hours
    });

    const avgHoldingPeriod = holdingPeriods.reduce((a, b) => a + b, 0) / holdingPeriods.length;
    const maxHoldingPeriod = Math.max(...holdingPeriods);
    const minHoldingPeriod = Math.min(...holdingPeriods);

    // Standard deviation
    const variance = holdingPeriods.reduce(
      (sum, h) => sum + Math.pow(h - avgHoldingPeriod, 2),
      0,
    ) / holdingPeriods.length;
    const stdDev = Math.sqrt(variance);

    // Time in market
    const firstEntry = Math.min(...trades.map((t) => t.entryTime.getTime()));
    const lastExit = Math.max(...trades.map((t) => t.exitTime.getTime()));
    const totalPeriodHours = (lastExit - firstEntry) / (1000 * 60 * 60);
    const totalHoldingHours = holdingPeriods.reduce((a, b) => a + b, 0);
    const timeInMarket = totalPeriodHours > 0 ? (totalHoldingHours / totalPeriodHours) * 100 : 0;

    // Trades per day
    const totalDays = totalPeriodHours / 24;
    const tradesPerDay = totalDays > 0 ? trades.length / totalDays : 0;

    return {
      avgHoldingPeriodHours: avgHoldingPeriod,
      maxHoldingPeriodHours: maxHoldingPeriod,
      minHoldingPeriodHours: minHoldingPeriod,
      holdingPeriodStdDev: stdDev,
      tradesPerDay,
      timeInMarketPercent: Math.min(timeInMarket, 100),
    };
  }

  /**
   * Calculate Ulcer Index
   */
  private calculateUlcerIndex(
    trades: TradeResult[],
    initialBalance: number,
  ): { ulcerIndex: number } {
    if (trades.length === 0) {
      return { ulcerIndex: 0 };
    }

    let balance = initialBalance;
    let peak = initialBalance;
    const squaredDrawdowns: number[] = [];

    for (const trade of trades) {
      balance += trade.pnlUsd;
      if (balance > peak) {
        peak = balance;
      }
      const drawdownPercent = ((peak - balance) / peak) * 100;
      squaredDrawdowns.push(drawdownPercent * drawdownPercent);
    }

    const meanSquaredDrawdown =
      squaredDrawdowns.reduce((a, b) => a + b, 0) / squaredDrawdowns.length;
    const ulcerIndex = Math.sqrt(meanSquaredDrawdown);

    return { ulcerIndex };
  }

  /**
   * Calculate overall score (0-100)
   */
  private calculateOverallScore(
    basic: BasicMetrics,
    risk: RiskMetrics,
    drawdown: DrawdownMetrics,
    streak: StreakMetrics,
  ): number {
    let score = 50; // Base score

    // Sharpe contribution (0-20)
    score += Math.min(risk.sharpeRatio * 10, 20);

    // Win rate contribution (0-10)
    if (basic.winRate >= 50) score += (basic.winRate - 50) / 5;

    // Profit factor contribution (0-10)
    score += Math.min((basic.profitFactor - 1) * 5, 10);

    // Drawdown penalty (-20 to 0)
    score -= Math.min(drawdown.maxDrawdownPercent, 20);

    // Loss streak penalty (-10 to 0)
    if (streak.maxConsecutiveLosses > 5) {
      score -= Math.min((streak.maxConsecutiveLosses - 5) * 2, 10);
    }

    // Sortino bonus (0-10)
    if (risk.sortinoRatio > risk.sharpeRatio) {
      score += Math.min((risk.sortinoRatio - risk.sharpeRatio) * 5, 10);
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Generate warnings based on metrics
   */
  private generateWarnings(
    basic: BasicMetrics,
    risk: RiskMetrics,
    drawdown: DrawdownMetrics,
    streak: StreakMetrics,
  ): string[] {
    const warnings: string[] = [];

    // Risk warnings
    if (risk.sharpeRatio < 1) {
      warnings.push(`Low Sharpe Ratio (${risk.sharpeRatio.toFixed(2)}) - risk-adjusted returns below threshold`);
    }

    if (drawdown.maxDrawdownPercent > 20) {
      warnings.push(`High Max Drawdown (${drawdown.maxDrawdownPercent.toFixed(1)}%) - significant loss of capital risk`);
    }

    if (streak.maxConsecutiveLosses >= 5) {
      warnings.push(`High consecutive losses (${streak.maxConsecutiveLosses}) - potential strategy breakdown risk`);
    }

    // Performance warnings
    if (basic.winRate < 40) {
      warnings.push(`Low win rate (${basic.winRate.toFixed(1)}%) - strategy may rely too heavily on few big wins`);
    }

    if (basic.profitFactor < 1.5) {
      warnings.push(`Low profit factor (${basic.profitFactor.toFixed(2)}) - insufficient edge`);
    }

    // Distribution warnings
    if (risk.skewness < -0.5) {
      warnings.push(`Negative skewness (${risk.skewness.toFixed(2)}) - returns skewed toward losses`);
    }

    if (risk.kurtosis > 3) {
      warnings.push(`High kurtosis (${risk.kurtosis.toFixed(2)}) - fat tails increase tail risk`);
    }

    // VaR warnings
    if (Math.abs(risk.cvar95) > 5) {
      warnings.push(`High CVaR95 (${risk.cvar95.toFixed(2)}%) - expected loss in worst 5% of trades is significant`);
    }

    return warnings;
  }

  /**
   * Calculate consistency score
   */
  private calculateConsistencyScore(trades: TradeResult[]): number {
    if (trades.length < 10) return 50;

    // Split into chunks and compare performance
    const chunkSize = Math.floor(trades.length / 4);
    const chunks: TradeResult[][] = [];
    for (let i = 0; i < 4; i++) {
      chunks.push(trades.slice(i * chunkSize, (i + 1) * chunkSize));
    }

    const chunkReturns = chunks.map((chunk) =>
      chunk.reduce((sum, t) => sum + t.pnlPercent, 0) / chunk.length,
    );

    // Check if all chunks are profitable
    const profitableChunks = chunkReturns.filter((r) => r > 0).length;

    // Calculate coefficient of variation
    const meanReturn = chunkReturns.reduce((a, b) => a + b, 0) / 4;
    const stdDev = Math.sqrt(
      chunkReturns.reduce((sum, r) => sum + Math.pow(r - meanReturn, 2), 0) / 4,
    );
    const cv = meanReturn !== 0 ? Math.abs(stdDev / meanReturn) : Infinity;

    // Score: all profitable + low CV = high score
    let score = profitableChunks * 15; // Max 60 from profitability
    score += Math.max(0, 40 - cv * 20); // Max 40 from consistency

    return Math.min(100, Math.round(score));
  }

  /**
   * Calculate robustness score
   */
  private calculateRobustnessScore(
    risk: RiskMetrics,
    drawdown: DrawdownMetrics,
  ): number {
    let score = 50;

    // Sharpe contribution
    score += Math.min(risk.sharpeRatio * 15, 25);

    // Sortino bonus
    if (risk.sortinoRatio > risk.sharpeRatio) {
      score += 10;
    }

    // Recovery factor contribution
    score += Math.min(drawdown.recoveryFactor * 5, 15);

    // Drawdown penalty
    score -= Math.min(drawdown.maxDrawdownPercent / 2, 20);

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Helper: Calculate average trade duration in days
   */
  private calculateAvgTradeDays(trades: TradeResult[]): number {
    if (trades.length === 0) return 1;

    const totalDays = trades.reduce((sum, t) => {
      const days = (t.exitTime.getTime() - t.entryTime.getTime()) / (1000 * 60 * 60 * 24);
      return sum + days;
    }, 0);

    return totalDays / trades.length;
  }

  /**
   * Helper: Calculate days between two dates
   */
  private daysBetween(start: Date, end: Date): number {
    return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  }

  /**
   * Get empty metrics structure
   */
  private getEmptyMetrics(): ExtendedMetrics {
    return {
      basic: this.getEmptyBasicMetrics(),
      risk: this.getEmptyRiskMetrics(),
      drawdown: this.getEmptyDrawdownMetrics(),
      streak: this.getEmptyStreakMetrics(),
      time: this.getEmptyTimeMetrics(),
      overallScore: 0,
      warnings: ['No trades to analyze'],
      summary: {
        riskAdjustedReturn: 0,
        consistencyScore: 0,
        robustnessScore: 0,
      },
    };
  }

  private getEmptyBasicMetrics(): BasicMetrics {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnlUsd: 0,
      totalPnlPercent: 0,
      avgPnlUsd: 0,
      avgWinUsd: 0,
      avgLossUsd: 0,
      profitFactor: 0,
      grossProfit: 0,
      grossLoss: 0,
    };
  }

  private getEmptyRiskMetrics(): RiskMetrics {
    return {
      sharpeRatio: 0,
      sortinoRatio: 0,
      calmarRatio: 0,
      var95: 0,
      cvar95: 0,
      var99: 0,
      cvar99: 0,
      ulcerIndex: 0,
      standardDeviation: 0,
      downsideDeviation: 0,
      skewness: 0,
      kurtosis: 0,
    };
  }

  private getEmptyDrawdownMetrics(): DrawdownMetrics {
    return {
      maxDrawdownPercent: 0,
      maxDrawdownUsd: 0,
      avgDrawdownPercent: 0,
      maxDrawdownDurationDays: 0,
      recoveryTimeDays: 0,
      recoveryFactor: 0,
      drawdownCount: 0,
      drawdownHistory: [],
    };
  }

  private getEmptyStreakMetrics(): StreakMetrics {
    return {
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      maxWinStreakUsd: 0,
      maxLossStreakUsd: 0,
      currentStreak: 0,
      avgWinStreak: 0,
      avgLossStreak: 0,
    };
  }

  private getEmptyTimeMetrics(): TimeMetrics {
    return {
      avgHoldingPeriodHours: 0,
      maxHoldingPeriodHours: 0,
      minHoldingPeriodHours: 0,
      holdingPeriodStdDev: 0,
      tradesPerDay: 0,
      timeInMarketPercent: 0,
    };
  }
}
