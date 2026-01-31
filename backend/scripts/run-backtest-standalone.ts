/**
 * Standalone Backtest Script
 *
 * DB 없이 새로운 전략(Core Trend, Squeeze)을 백테스트합니다.
 *
 * 실행: npx ts-node scripts/run-backtest-standalone.ts
 */

import { BinanceDataDownloaderService, Candle } from '../src/backtest/services/binance-data-downloader.service';
import { CoreTrendStrategy } from '../src/strategies/core-trend/core-trend.strategy';
import { SqueezeStrategy } from '../src/strategies/squeeze/squeeze.strategy';
import { FundingOverlay } from '../src/strategies/funding-overlay/funding-overlay';
import { createBacktestAdapter, BacktestDataAdapter } from '../src/adapters/backtest/backtest-data-adapter';
import { TradingSignal } from '../src/strategies/core/interfaces';

// Top 50 coins by volume (Binance Futures)
const TOP_50_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
  'MATICUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT',
  'XLMUSDT', 'FILUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT',
  'NEARUSDT', 'AAVEUSDT', 'MKRUSDT', 'INJUSDT', 'SUIUSDT',
  'TIAUSDT', 'SEIUSDT', 'RUNEUSDT', 'LDOUSDT', 'RNDRUSDT',
  'FETUSDT', 'GRTUSDT', 'IMXUSDT', 'STXUSDT', 'ALGOUSDT',
  'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'GALAUSDT', 'APEUSDT',
  'CFXUSDT', 'AGIXUSDT', 'WLDUSDT', 'PENDLEUSDT', 'JUPUSDT',
  'ENAUSDT', 'WIFUSDT', 'PEOPLEUSDT', 'BONKUSDT', 'ORDIUSDT',
];

// Config
const CONFIG = {
  symbols: TOP_50_SYMBOLS,
  strategies: ['CORE_TREND', 'SQUEEZE'],
  startDate: new Date('2025-12-01'),
  endDate: new Date('2025-12-31'),
  // Data download starts earlier for EMA warmup (need 200+ 1D candles)
  dataStartDate: new Date('2025-04-01'), // ~8 months earlier for 1D EMA200
  initialBalance: 200,
};

// Trade tracking with partial close support
interface SimTrade {
  symbol: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  slPrice: number;
  tp1Price: number;
  trailingSl?: number;  // Trailing stop after TP1
  entryTime: number;
  exitTime?: number;
  initialSizeUsd: number;    // Original position size
  remainingSizeUsd: number;  // Remaining after partial close
  realizedPnlUsd: number;    // PnL from partial closes
  pnlUsd?: number;           // Final total PnL
  closeReason?: string;
  tp1Hit: boolean;
  signal: TradingSignal;
}

// Simple logger (no DI needed)
const logger = {
  log: (msg: string, ctx?: string) => console.log(`[${ctx || 'LOG'}] ${msg}`),
  warn: (msg: string, ctx?: string) => console.warn(`[${ctx || 'WARN'}] ${msg}`),
  error: (msg: string, ctx?: string) => console.error(`[${ctx || 'ERROR'}] ${msg}`),
};

// Create downloader without DI
class StandaloneDownloader extends BinanceDataDownloaderService {
  constructor() {
    super(logger as any);
  }
}

/**
 * Cost Model (P0-3)
 * - Commission: 0.05% per side (0.1% round-trip)
 * - Slippage: max(0.01%, 0.05 * ATR%) - ATR-proportional for breakout entries
 * - All R calculations are NET (after costs)
 */
const COMMISSION_RATE = 0.0005; // 0.05% per side
const MIN_SLIPPAGE_RATE = 0.0001; // 0.01% minimum
const SLIPPAGE_ATR_MULT = 0.05; // 5% of ATR as slippage
const SLIPPAGE_RATE = 0.0002; // Default 0.02% (used when ATR not available)

function calculateSlippage(entryPrice: number, atr: number | undefined): number {
  if (!atr) return MIN_SLIPPAGE_RATE;
  const atrPercent = atr / entryPrice;
  return Math.max(MIN_SLIPPAGE_RATE, atrPercent * SLIPPAGE_ATR_MULT);
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
  const commission = positionSizeUsd * COMMISSION_RATE * 2; // Entry + Exit
  const pnlUsd = grossPnl - commission;
  const pnlPercent = (pnlUsd / positionSizeUsd) * 100;
  return { pnlUsd, pnlPercent };
}

async function main() {
  console.log('\n========================================');
  console.log('  New Strategies Backtest (Standalone)');
  console.log('========================================\n');
  console.log(`Symbols: ${CONFIG.symbols.join(', ')}`);
  console.log(`Strategies: ${CONFIG.strategies.join(', ')}`);
  console.log(`Period: ${CONFIG.startDate.toISOString().split('T')[0]} ~ ${CONFIG.endDate.toISOString().split('T')[0]}`);
  console.log(`Initial Balance: $${CONFIG.initialBalance}\n`);

  const downloader = new StandaloneDownloader();

  // Download data
  console.log('=== Downloading Historical Data ===\n');

  const candleData = new Map<string, Candle[]>();
  const fundingData = new Map<string, number[]>();
  const timeframes = ['15m', '1h', '4h', '1d'];

  // Always include BTCUSDT
  const allSymbols = [...new Set([...CONFIG.symbols, 'BTCUSDT'])];

  for (const symbol of allSymbols) {
    for (const tf of timeframes) {
      console.log(`Downloading ${symbol} ${tf}...`);
      try {
        // Use dataStartDate for warmup period (EMA200 needs 200+ days)
        const candles = await downloader.downloadData(
          symbol,
          tf,
          CONFIG.dataStartDate,
          CONFIG.endDate,
        );
        candleData.set(`${symbol}_${tf}`, candles);
        console.log(`  ✓ ${candles.length} candles`);
      } catch (error) {
        console.log(`  ✗ Failed: ${error.message}`);
      }
    }

    // Download funding
    console.log(`Downloading ${symbol} funding rates...`);
    try {
      const rates = await downloader.downloadFundingHistory(
        symbol,
        CONFIG.dataStartDate,
        CONFIG.endDate,
      );
      fundingData.set(symbol, rates);
      console.log(`  ✓ ${rates.length} funding rates`);
    } catch (error) {
      console.log(`  ✗ Failed: ${error.message}`);
    }
  }

  // Create adapter
  console.log('\n=== Creating Backtest Adapter ===\n');
  const adapter = createBacktestAdapter(candleData as any, fundingData, CONFIG.symbols);

  // Initialize strategies
  const coreTrendStrategy = new CoreTrendStrategy();
  const squeezeStrategy = new SqueezeStrategy();
  const fundingOverlay = new FundingOverlay();

  // Get all timestamps from 4h candles (only after startDate for actual trading)
  const timestamps = new Set<number>();
  const startTime = CONFIG.startDate.getTime();
  for (const [key, candles] of candleData.entries()) {
    if (key.endsWith('_4h') || key.endsWith('_15m')) {
      candles
        .filter(c => c.closeTime >= startTime) // Only trade after startDate
        .forEach(c => timestamps.add(c.closeTime));
    }
  }
  const sortedTimestamps = Array.from(timestamps).sort((a, b) => a - b);

  console.log(`Simulating ${sortedTimestamps.length} time steps (trading period only)...\n`);
  console.log(`Warmup data: ${CONFIG.dataStartDate.toISOString().split('T')[0]} ~ ${CONFIG.startDate.toISOString().split('T')[0]}\n`);

  // Simulation
  const openPositions = new Map<string, SimTrade>();
  const closedTrades: SimTrade[] = [];
  let balance = CONFIG.initialBalance;

  for (let i = 0; i < sortedTimestamps.length; i++) {
    const timestamp = sortedTimestamps[i];
    adapter.setCurrentTime(timestamp);

    // Progress update
    if (i % 1000 === 0) {
      const progress = Math.round((i / sortedTimestamps.length) * 100);
      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      process.stdout.write(`\rProgress: ${progress}% (${dateStr})`);
    }

    // Check open positions
    for (const [posKey, trade] of openPositions.entries()) {
      const currentPrice = adapter.getCurrentPrice(trade.symbol);
      if (!currentPrice) continue;

      const isLong = trade.direction === 'LONG';
      let shouldClose = false;
      let closeReason = '';
      let exitPrice = currentPrice;

      // Determine which SL to use (trailing if TP1 hit, otherwise initial)
      const effectiveSl = trade.tp1Hit && trade.trailingSl ? trade.trailingSl : trade.slPrice;

      // Check SL (or trailing SL)
      if (isLong && currentPrice <= effectiveSl) {
        shouldClose = true;
        closeReason = trade.tp1Hit ? 'TRAILING_SL' : 'SL';
        exitPrice = effectiveSl * (1 - SLIPPAGE_RATE);
      } else if (!isLong && currentPrice >= effectiveSl) {
        shouldClose = true;
        closeReason = trade.tp1Hit ? 'TRAILING_SL' : 'SL';
        exitPrice = effectiveSl * (1 + SLIPPAGE_RATE);
      }

      // Check TP1 (partial close)
      if (!shouldClose && !trade.tp1Hit) {
        const tp1Reached = isLong
          ? currentPrice >= trade.tp1Price
          : currentPrice <= trade.tp1Price;

        if (tp1Reached) {
          // Partial close at TP1
          const tp1ExitPrice = trade.tp1Price * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
          const tp1QtyPct = trade.signal.tp1QtyPercent; // 25-30%
          const tp1Size = trade.initialSizeUsd * tp1QtyPct;

          const tp1Pnl = calculatePnl(trade.entryPrice, tp1ExitPrice, tp1Size, trade.direction);
          trade.realizedPnlUsd += tp1Pnl.pnlUsd;
          trade.remainingSizeUsd = trade.initialSizeUsd - tp1Size;
          trade.tp1Hit = true;

          // Move SL to breakeven
          trade.slPrice = trade.entryPrice;

          // Set initial trailing stop
          const atr = trade.signal.metadata?.atr as number || (trade.entryPrice * 0.02);
          const trailMult = trade.signal.trailAtrMult;
          trade.trailingSl = isLong
            ? currentPrice - (atr * trailMult)
            : currentPrice + (atr * trailMult);

          balance += tp1Pnl.pnlUsd;
        }
      }

      // Update trailing stop if TP1 hit
      if (!shouldClose && trade.tp1Hit && trade.trailingSl) {
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

      // Check time stop (Core Trend: 30 4H bars = 120 hours)
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
        // Close remaining position
        const remainingPnl = calculatePnl(trade.entryPrice, exitPrice, trade.remainingSizeUsd, trade.direction);

        // Add funding cost for the entire holding period
        const fundingCost = adapter.calculateFundingCost(
          trade.symbol,
          trade.initialSizeUsd,  // Funding on original size
          trade.entryTime,
          timestamp,
          trade.direction,
        );

        trade.exitPrice = exitPrice;
        trade.exitTime = timestamp;
        trade.pnlUsd = trade.realizedPnlUsd + remainingPnl.pnlUsd - fundingCost;
        trade.closeReason = closeReason;

        balance += remainingPnl.pnlUsd - fundingCost;
        closedTrades.push(trade);
        openPositions.delete(posKey);
      }
    }

    // Generate signals
    for (const symbol of CONFIG.symbols) {
      const posKey = symbol;
      if (openPositions.has(posKey)) continue;
      if (openPositions.size >= 5) continue; // Max positions

      let signal: TradingSignal | null = null;

      // Core Trend
      if (CONFIG.strategies.includes('CORE_TREND') && !signal) {
        signal = coreTrendStrategy.generateSignal(symbol, adapter);
      }

      // Squeeze
      if (CONFIG.strategies.includes('SQUEEZE') && !signal) {
        signal = squeezeStrategy.generateSignal(symbol, adapter);
      }

      if (signal && signal.detected) {
        // Apply funding overlay
        const fundingRate = adapter.getFundingRate(symbol);
        const fundingHistory = adapter.getFundingHistory(symbol, 200);
        const fundingResult = fundingOverlay.analyze(fundingRate, fundingHistory, signal.direction);

        if (fundingResult.action === 'BLOCK') continue;

        const finalSignal = fundingOverlay.applyToSignal(signal, fundingResult);
        if (!finalSignal) continue;

        // Volatility-based sizing
        const riskPerTrade = balance * 0.005;
        const stopDistance = Math.abs(finalSignal.entryPrice - finalSignal.slPrice);
        const positionSizeUsd = stopDistance > 0 ? riskPerTrade / (stopDistance / finalSignal.entryPrice) : 0;

        if (positionSizeUsd < 100) continue; // Min position

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

        openPositions.set(posKey, trade);
      }
    }
  }

  // Close remaining positions
  for (const [posKey, trade] of openPositions.entries()) {
    const currentPrice = adapter.getCurrentPrice(trade.symbol);
    if (!currentPrice) continue;

    const isLong = trade.direction === 'LONG';
    const exitPrice = currentPrice * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
    const remainingPnl = calculatePnl(trade.entryPrice, exitPrice, trade.remainingSizeUsd, trade.direction);

    trade.exitPrice = exitPrice;
    trade.exitTime = sortedTimestamps[sortedTimestamps.length - 1];
    trade.pnlUsd = trade.realizedPnlUsd + remainingPnl.pnlUsd;
    trade.closeReason = 'END_OF_BACKTEST';

    balance += remainingPnl.pnlUsd;
    closedTrades.push(trade);
  }

  // Calculate metrics
  console.log('\n\n========================================');
  console.log('  Backtest Results');
  console.log('========================================\n');

  const winningTrades = closedTrades.filter(t => t.pnlUsd! > 0);
  const losingTrades = closedTrades.filter(t => t.pnlUsd! <= 0);
  const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnlUsd!, 0);
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnlUsd!, 0);
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnlUsd!, 0));

  // Max drawdown
  let peak = CONFIG.initialBalance;
  let maxDrawdown = 0;
  let runningBalance = CONFIG.initialBalance;

  for (const trade of closedTrades.sort((a, b) => a.exitTime! - b.exitTime!)) {
    runningBalance += trade.pnlUsd!;
    if (runningBalance > peak) peak = runningBalance;
    const dd = ((peak - runningBalance) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe Ratio
  const returns = closedTrades.map(t => (t.pnlUsd! / t.initialSizeUsd) * 100);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev = returns.length > 0
    ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
    : 0;
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  console.log('--- Overall Performance ---');
  console.log(`Total Trades: ${closedTrades.length}`);
  console.log(`Winning Trades: ${winningTrades.length} (${closedTrades.length > 0 ? ((winningTrades.length / closedTrades.length) * 100).toFixed(1) : 0}%)`);
  console.log(`Losing Trades: ${losingTrades.length}`);
  console.log(`\nTotal PnL: $${totalPnl.toFixed(2)} (${((totalPnl / CONFIG.initialBalance) * 100).toFixed(2)}%)`);
  console.log(`Final Balance: $${(CONFIG.initialBalance + totalPnl).toFixed(2)}`);
  console.log(`\nMax Drawdown: ${maxDrawdown.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${sharpeRatio.toFixed(2)}`);
  console.log(`Profit Factor: ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}`);

  // By strategy
  console.log('\n--- By Strategy ---');
  for (const strategy of CONFIG.strategies) {
    const stratTrades = closedTrades.filter(t => t.strategy === strategy);
    const stratWins = stratTrades.filter(t => t.pnlUsd! > 0);
    const stratPnl = stratTrades.reduce((sum, t) => sum + t.pnlUsd!, 0);

    console.log(`\n${strategy}:`);
    console.log(`  Trades: ${stratTrades.length}`);
    console.log(`  Win Rate: ${stratTrades.length > 0 ? ((stratWins.length / stratTrades.length) * 100).toFixed(1) : 0}%`);
    console.log(`  PnL: $${stratPnl.toFixed(2)}`);
  }

  // By symbol
  console.log('\n--- By Symbol ---');
  for (const symbol of CONFIG.symbols) {
    const symTrades = closedTrades.filter(t => t.symbol === symbol);
    const symPnl = symTrades.reduce((sum, t) => sum + t.pnlUsd!, 0);

    console.log(`${symbol}: ${symTrades.length} trades, $${symPnl.toFixed(2)}`);
  }

  // By close reason
  console.log('\n--- By Close Reason ---');
  const closeReasons = new Map<string, number>();
  for (const trade of closedTrades) {
    const count = closeReasons.get(trade.closeReason!) || 0;
    closeReasons.set(trade.closeReason!, count + 1);
  }
  for (const [reason, count] of closeReasons.entries()) {
    console.log(`${reason}: ${count}`);
  }

  // Recent trades
  console.log('\n--- Sample Trades (Last 10) ---');
  const recentTrades = closedTrades.slice(-10);
  for (const t of recentTrades) {
    const date = new Date(t.exitTime!).toISOString().split('T')[0];
    const pnlStr = t.pnlUsd! >= 0 ? `+$${t.pnlUsd!.toFixed(2)}` : `-$${Math.abs(t.pnlUsd!).toFixed(2)}`;
    const tp1Str = t.tp1Hit ? '(TP1✓)' : '';
    console.log(`${date} | ${t.symbol} | ${t.strategy} | ${t.direction} | ${t.closeReason} ${tp1Str} | ${pnlStr}`);
  }

  console.log('\n========================================\n');
}

main().catch(console.error);
