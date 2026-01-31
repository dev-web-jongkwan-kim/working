/**
 * TP1 Strategy Comparison Backtest
 *
 * Compares different TP1 exit strategies:
 * 1. Current (25-30%)
 * 2. 50% exit
 * 3. 70% exit
 * 4. 100% exit (full close at TP1)
 */

import { BinanceDataDownloaderService, Candle } from '../src/backtest/services/binance-data-downloader.service';
import { CoreTrendStrategy } from '../src/strategies/core-trend/core-trend.strategy';
import { SqueezeStrategy } from '../src/strategies/squeeze/squeeze.strategy';
import { FundingOverlay } from '../src/strategies/funding-overlay/funding-overlay';
import { createBacktestAdapter } from '../src/adapters/backtest/backtest-data-adapter';
import { TradingSignal } from '../src/strategies/core/interfaces';

// Symbols
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
  'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'XLMUSDT',
  'FILUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'NEARUSDT',
];

// TP1 strategies to compare
const TP1_STRATEGIES = [
  { name: 'TP1_25%', tp1Pct: 0.25 },
  { name: 'TP1_50%', tp1Pct: 0.50 },
  { name: 'TP1_70%', tp1Pct: 0.70 },
  { name: 'TP1_100%', tp1Pct: 1.00 },
];

// Config
const CONFIG = {
  startDate: new Date('2025-12-01'),
  endDate: new Date('2025-12-31'),
  dataStartDate: new Date('2025-04-01'),
  initialBalance: 1000,
};

// Cost model
const COMMISSION_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0002;

interface SimTrade {
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  slPrice: number;
  tp1Price: number;
  trailingSl?: number;
  entryTime: number;
  exitTime?: number;
  initialSizeUsd: number;
  remainingSizeUsd: number;
  realizedPnlUsd: number;
  pnlUsd?: number;
  closeReason?: string;
  tp1Hit: boolean;
  signal: TradingSignal;
}

interface BacktestResult {
  strategyName: string;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  returnPct: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  tp1HitRate: number;
  avgPnlAfterTp1: number;
}

const logger = {
  log: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

class StandaloneDownloader extends BinanceDataDownloaderService {
  constructor() {
    super(logger as any);
  }
}

function calculatePnl(
  entryPrice: number,
  exitPrice: number,
  positionSizeUsd: number,
  direction: 'LONG' | 'SHORT',
): { pnlUsd: number; pnlPercent: number } {
  const isLong = direction === 'LONG';
  const priceDiff = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = (priceDiff / entryPrice) * positionSizeUsd;
  const commission = positionSizeUsd * COMMISSION_RATE * 2;
  const pnlUsd = grossPnl - commission;
  const pnlPercent = (pnlUsd / positionSizeUsd) * 100;
  return { pnlUsd, pnlPercent };
}

async function runBacktest(
  adapter: any,
  timestamps: number[],
  tp1Pct: number,
  initialBalance: number,
): Promise<{ trades: SimTrade[]; finalBalance: number }> {
  const coreTrendStrategy = new CoreTrendStrategy();
  const squeezeStrategy = new SqueezeStrategy();
  const fundingOverlay = new FundingOverlay();

  const openPositions = new Map<string, SimTrade>();
  const closedTrades: SimTrade[] = [];
  let balance = initialBalance;

  for (const timestamp of timestamps) {
    adapter.setCurrentTime(timestamp);

    // Check open positions
    for (const [posKey, trade] of openPositions.entries()) {
      const currentPrice = adapter.getCurrentPrice(trade.symbol);
      if (!currentPrice) continue;

      const isLong = trade.direction === 'LONG';
      let shouldClose = false;
      let closeReason = '';
      let exitPrice = currentPrice;

      const effectiveSl = trade.tp1Hit && trade.trailingSl ? trade.trailingSl : trade.slPrice;

      // Check SL
      if (isLong && currentPrice <= effectiveSl) {
        shouldClose = true;
        closeReason = trade.tp1Hit ? 'TRAILING_SL' : 'SL';
        exitPrice = effectiveSl * (1 - SLIPPAGE_RATE);
      } else if (!isLong && currentPrice >= effectiveSl) {
        shouldClose = true;
        closeReason = trade.tp1Hit ? 'TRAILING_SL' : 'SL';
        exitPrice = effectiveSl * (1 + SLIPPAGE_RATE);
      }

      // Check TP1
      if (!shouldClose && !trade.tp1Hit) {
        const tp1Reached = isLong
          ? currentPrice >= trade.tp1Price
          : currentPrice <= trade.tp1Price;

        if (tp1Reached) {
          const tp1ExitPrice = trade.tp1Price * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
          const tp1Size = trade.initialSizeUsd * tp1Pct;

          const tp1Pnl = calculatePnl(trade.entryPrice, tp1ExitPrice, tp1Size, trade.direction);
          trade.realizedPnlUsd += tp1Pnl.pnlUsd;
          trade.remainingSizeUsd = trade.initialSizeUsd - tp1Size;
          trade.tp1Hit = true;

          // If 100% exit at TP1
          if (tp1Pct >= 1.0) {
            trade.exitPrice = tp1ExitPrice;
            trade.exitTime = timestamp;
            trade.pnlUsd = trade.realizedPnlUsd;
            trade.closeReason = 'TP1_FULL';
            balance += tp1Pnl.pnlUsd;
            closedTrades.push(trade);
            openPositions.delete(posKey);
            continue;
          }

          // Move SL to breakeven
          trade.slPrice = trade.entryPrice;

          // Set trailing stop
          const atr = trade.signal.metadata?.atr as number || (trade.entryPrice * 0.02);
          const trailMult = trade.signal.trailAtrMult;
          trade.trailingSl = isLong
            ? currentPrice - (atr * trailMult)
            : currentPrice + (atr * trailMult);

          balance += tp1Pnl.pnlUsd;
        }
      }

      // Update trailing stop
      if (!shouldClose && trade.tp1Hit && trade.trailingSl && tp1Pct < 1.0) {
        const atr = trade.signal.metadata?.atr as number || (trade.entryPrice * 0.02);
        const trailMult = trade.signal.trailAtrMult;

        if (isLong) {
          const newTrailingSl = currentPrice - (atr * trailMult);
          if (newTrailingSl > trade.trailingSl) {
            trade.trailingSl = newTrailingSl;
          }
        } else {
          const newTrailingSl = currentPrice + (atr * trailMult);
          if (newTrailingSl < trade.trailingSl) {
            trade.trailingSl = newTrailingSl;
          }
        }
      }

      // Time stop
      if (!shouldClose && trade.signal.timeStopBars) {
        const barDurationMs = trade.strategy === 'CORE_TREND' ? 4 * 60 * 60 * 1000 : 15 * 60 * 1000;
        const barsSinceEntry = Math.floor((timestamp - trade.entryTime) / barDurationMs);
        if (barsSinceEntry >= trade.signal.timeStopBars) {
          shouldClose = true;
          closeReason = 'TIME_STOP';
          exitPrice = currentPrice * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
        }
      }

      if (shouldClose) {
        const remainingPnl = calculatePnl(trade.entryPrice, exitPrice, trade.remainingSizeUsd, trade.direction);
        trade.exitPrice = exitPrice;
        trade.exitTime = timestamp;
        trade.pnlUsd = trade.realizedPnlUsd + remainingPnl.pnlUsd;
        trade.closeReason = closeReason;
        balance += remainingPnl.pnlUsd;
        closedTrades.push(trade);
        openPositions.delete(posKey);
      }
    }

    // Generate signals
    for (const symbol of SYMBOLS) {
      if (openPositions.has(symbol)) continue;
      if (openPositions.size >= 5) continue;

      let signal: TradingSignal | null = null;

      signal = coreTrendStrategy.generateSignal(symbol, adapter);
      if (!signal) {
        signal = squeezeStrategy.generateSignal(symbol, adapter);
      }

      if (signal && signal.detected) {
        const fundingRate = adapter.getFundingRate(symbol);
        const fundingHistory = adapter.getFundingHistory(symbol, 200);
        const fundingResult = fundingOverlay.analyze(fundingRate, fundingHistory, signal.direction);

        if (fundingResult.action === 'BLOCK') continue;

        const finalSignal = fundingOverlay.applyToSignal(signal, fundingResult);
        if (!finalSignal) continue;

        const riskPerTrade = balance * 0.005;
        const stopDistance = Math.abs(finalSignal.entryPrice - finalSignal.slPrice);
        const positionSizeUsd = stopDistance > 0 ? riskPerTrade / (stopDistance / finalSignal.entryPrice) : 0;

        if (positionSizeUsd < 50) continue;

        const entryPrice = finalSignal.entryPrice * (1 + SLIPPAGE_RATE * (finalSignal.direction === 'LONG' ? 1 : -1));

        const trade: SimTrade = {
          symbol,
          strategy: finalSignal.strategyType,
          direction: finalSignal.direction,
          entryPrice,
          slPrice: finalSignal.slPrice,
          tp1Price: finalSignal.tp1Price,
          entryTime: timestamp,
          initialSizeUsd: positionSizeUsd,
          remainingSizeUsd: positionSizeUsd,
          realizedPnlUsd: 0,
          tp1Hit: false,
          signal: finalSignal,
        };

        openPositions.set(symbol, trade);
      }
    }
  }

  // Close remaining positions
  const lastTimestamp = timestamps[timestamps.length - 1];
  for (const [, trade] of openPositions.entries()) {
    const currentPrice = adapter.getCurrentPrice(trade.symbol);
    if (!currentPrice) continue;

    const isLong = trade.direction === 'LONG';
    const exitPrice = currentPrice * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
    const remainingPnl = calculatePnl(trade.entryPrice, exitPrice, trade.remainingSizeUsd, trade.direction);

    trade.exitPrice = exitPrice;
    trade.exitTime = lastTimestamp;
    trade.pnlUsd = trade.realizedPnlUsd + remainingPnl.pnlUsd;
    trade.closeReason = 'END_OF_BACKTEST';
    balance += remainingPnl.pnlUsd;
    closedTrades.push(trade);
  }

  return { trades: closedTrades, finalBalance: balance };
}

function analyzeResults(
  strategyName: string,
  trades: SimTrade[],
  initialBalance: number,
  finalBalance: number,
): BacktestResult {
  const winningTrades = trades.filter(t => t.pnlUsd! > 0);
  const losingTrades = trades.filter(t => t.pnlUsd! <= 0);
  const tp1HitTrades = trades.filter(t => t.tp1Hit);

  const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd!, 0);
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnlUsd!, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlUsd!, 0));

  // Avg PnL after TP1 hit (excluding TP1 portion)
  const avgPnlAfterTp1 = tp1HitTrades.length > 0
    ? tp1HitTrades.reduce((sum, t) => {
        // PnL from trailing portion only
        const tp1Pnl = t.realizedPnlUsd;
        const trailingPnl = t.pnlUsd! - tp1Pnl;
        return sum + trailingPnl;
      }, 0) / tp1HitTrades.length
    : 0;

  // Max drawdown
  let peak = initialBalance;
  let maxDrawdown = 0;
  let runningBalance = initialBalance;
  for (const trade of trades.sort((a, b) => a.exitTime! - b.exitTime!)) {
    runningBalance += trade.pnlUsd!;
    if (runningBalance > peak) peak = runningBalance;
    const drawdown = (peak - runningBalance) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return {
    strategyName,
    totalTrades: trades.length,
    winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
    totalPnl,
    returnPct: ((finalBalance - initialBalance) / initialBalance) * 100,
    avgWin: winningTrades.length > 0 ? grossProfit / winningTrades.length : 0,
    avgLoss: losingTrades.length > 0 ? grossLoss / losingTrades.length : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown: maxDrawdown * 100,
    tp1HitRate: trades.length > 0 ? (tp1HitTrades.length / trades.length) * 100 : 0,
    avgPnlAfterTp1,
  };
}

async function main() {
  console.log('\n==========================================');
  console.log('  TP1 Exit Strategy Comparison Backtest');
  console.log('==========================================\n');

  const downloader = new StandaloneDownloader();

  // Download data
  console.log('=== Downloading Data ===\n');

  const candleData = new Map<string, Candle[]>();
  const fundingData = new Map<string, number[]>();
  const timeframes = ['15m', '1h', '4h', '1d'];
  const allSymbols = [...new Set([...SYMBOLS, 'BTCUSDT'])];

  for (const symbol of allSymbols) {
    for (const tf of timeframes) {
      try {
        const candles = await downloader.downloadData(symbol, tf, CONFIG.dataStartDate, CONFIG.endDate);
        candleData.set(`${symbol}_${tf}`, candles);
        process.stdout.write(`\r${symbol} ${tf}: ${candles.length} candles    `);
      } catch (error) {
        console.log(`\n${symbol} ${tf}: Failed`);
      }
    }

    try {
      const rates = await downloader.downloadFundingHistory(symbol, CONFIG.dataStartDate, CONFIG.endDate);
      fundingData.set(symbol, rates);
    } catch (error) {
      // ignore
    }
  }

  console.log('\n\n=== Running Backtests ===\n');

  // Get timestamps
  const timestamps = new Set<number>();
  const startTime = CONFIG.startDate.getTime();
  for (const [key, candles] of candleData.entries()) {
    if (key.endsWith('_4h') || key.endsWith('_15m')) {
      candles.filter(c => c.closeTime >= startTime).forEach(c => timestamps.add(c.closeTime));
    }
  }
  const sortedTimestamps = Array.from(timestamps).sort((a, b) => a - b);

  const results: BacktestResult[] = [];

  for (const strategy of TP1_STRATEGIES) {
    console.log(`\nTesting ${strategy.name}...`);

    const adapter = createBacktestAdapter(candleData as any, fundingData, SYMBOLS);
    const { trades, finalBalance } = await runBacktest(
      adapter,
      sortedTimestamps,
      strategy.tp1Pct,
      CONFIG.initialBalance,
    );

    const result = analyzeResults(strategy.name, trades, CONFIG.initialBalance, finalBalance);
    results.push(result);

    console.log(`  Trades: ${result.totalTrades}, Win Rate: ${result.winRate.toFixed(1)}%, Return: ${result.returnPct.toFixed(2)}%`);
  }

  // Print comparison table
  console.log('\n\n==========================================');
  console.log('  COMPARISON RESULTS');
  console.log('==========================================\n');

  console.log('┌────────────┬────────┬──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬────────────┐');
  console.log('│ Strategy   │ Trades │ Win Rate │ Return % │ Avg Win  │ Avg Loss │ PF       │ Max DD   │ TP1 Hit %  │');
  console.log('├────────────┼────────┼──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼────────────┤');

  for (const r of results) {
    const pf = r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2);
    console.log(
      `│ ${r.strategyName.padEnd(10)} │ ${r.totalTrades.toString().padStart(6)} │ ${r.winRate.toFixed(1).padStart(7)}% │ ${r.returnPct.toFixed(2).padStart(7)}% │ $${r.avgWin.toFixed(2).padStart(6)} │ $${r.avgLoss.toFixed(2).padStart(6)} │ ${pf.padStart(8)} │ ${r.maxDrawdown.toFixed(1).padStart(6)}% │ ${r.tp1HitRate.toFixed(1).padStart(8)}%  │`
    );
  }

  console.log('└────────────┴────────┴──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴────────────┘');

  // Analysis
  console.log('\n=== ANALYSIS ===\n');

  const best = results.reduce((a, b) => a.returnPct > b.returnPct ? a : b);
  const safest = results.reduce((a, b) => a.maxDrawdown < b.maxDrawdown ? a : b);
  const highestPF = results.reduce((a, b) =>
    (a.profitFactor === Infinity ? 999 : a.profitFactor) > (b.profitFactor === Infinity ? 999 : b.profitFactor) ? a : b
  );

  console.log(`📈 Best Return: ${best.strategyName} (${best.returnPct.toFixed(2)}%)`);
  console.log(`🛡️  Lowest Drawdown: ${safest.strategyName} (${safest.maxDrawdown.toFixed(1)}%)`);
  console.log(`⚖️  Highest Profit Factor: ${highestPF.strategyName} (${highestPF.profitFactor === Infinity ? '∞' : highestPF.profitFactor.toFixed(2)})`);

  // TP1 후 trailing 수익 분석
  console.log('\n=== TP1 이후 Trailing 수익 분석 ===\n');
  for (const r of results) {
    if (r.strategyName !== 'TP1_100%') {
      console.log(`${r.strategyName}: TP1 후 평균 추가 수익 $${r.avgPnlAfterTp1.toFixed(2)}`);
    }
  }
}

main().catch(console.error);
