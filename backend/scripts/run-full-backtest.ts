/**
 * Full Backtest - Top 50 Symbols
 * 2025-10-01 ~ 2026-01-25
 */

import { BinanceDataDownloaderService, Candle } from '../src/backtest/services/binance-data-downloader.service';
import { CoreTrendStrategy } from '../src/strategies/core-trend/core-trend.strategy';
import { SqueezeStrategy } from '../src/strategies/squeeze/squeeze.strategy';
import { FundingOverlay } from '../src/strategies/funding-overlay/funding-overlay';
import { createBacktestAdapter } from '../src/adapters/backtest/backtest-data-adapter';
import { TradingSignal } from '../src/strategies/core/interfaces';

const TOP_50_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
  'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'ETCUSDT', 'XLMUSDT',
  'FILUSDT', 'APTUSDT', 'ARBUSDT', 'OPUSDT', 'NEARUSDT',
  'AAVEUSDT', 'MKRUSDT', 'INJUSDT', 'SUIUSDT', 'TIAUSDT',
  'SEIUSDT', 'RUNEUSDT', 'LDOUSDT', 'RNDRUSDT', 'FETUSDT',
  'GRTUSDT', 'IMXUSDT', 'STXUSDT', 'ALGOUSDT', 'SANDUSDT',
  'MANAUSDT', 'AXSUSDT', 'GALAUSDT', 'APEUSDT', 'CFXUSDT',
  'AGIXUSDT', 'WLDUSDT', 'PENDLEUSDT', 'JUPUSDT', 'ENAUSDT',
  'WIFUSDT', 'PEOPLEUSDT', 'BONKUSDT', 'ORDIUSDT', '1000PEPEUSDT',
];

const CONFIG = {
  startDate: new Date('2026-01-24'),
  endDate: new Date('2026-01-31'),
  dataStartDate: new Date('2025-05-01'), // 8 months for EMA200
  initialBalance: 1000,
};

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

const logger = {
  log: (msg: string) => console.log(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

class StandaloneDownloader extends BinanceDataDownloaderService {
  constructor() { super(logger as any); }
}

function calculatePnl(entryPrice: number, exitPrice: number, positionSizeUsd: number, direction: 'LONG' | 'SHORT') {
  const isLong = direction === 'LONG';
  const priceDiff = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = (priceDiff / entryPrice) * positionSizeUsd;
  const commission = positionSizeUsd * COMMISSION_RATE * 2;
  return { pnlUsd: grossPnl - commission, pnlPercent: ((grossPnl - commission) / positionSizeUsd) * 100 };
}

async function main() {
  console.log('\n==========================================');
  console.log('  Full Backtest - Top 50 Symbols');
  console.log('==========================================\n');
  console.log('Period: 2025-10-01 ~ 2026-01-25');
  console.log('Initial Balance: $' + CONFIG.initialBalance + '\n');

  const downloader = new StandaloneDownloader();
  const candleData = new Map<string, Candle[]>();
  const fundingData = new Map<string, number[]>();
  const timeframes = ['15m', '1h', '4h', '1d'];
  const allSymbols = [...new Set([...TOP_50_SYMBOLS, 'BTCUSDT'])];

  let downloadedCount = 0;
  const totalDownloads = allSymbols.length * (timeframes.length + 1);

  console.log('=== Downloading Data ===\n');

  for (const symbol of allSymbols) {
    for (const tf of timeframes) {
      try {
        const candles = await downloader.downloadData(symbol, tf, CONFIG.dataStartDate, CONFIG.endDate);
        candleData.set(symbol + '_' + tf, candles);
        downloadedCount++;
        process.stdout.write('\rDownloading... ' + Math.round(downloadedCount/totalDownloads*100) + '% (' + symbol + ' ' + tf + ')      ');
      } catch (error) {
        downloadedCount++;
      }
    }
    try {
      const rates = await downloader.downloadFundingHistory(symbol, CONFIG.dataStartDate, CONFIG.endDate);
      fundingData.set(symbol, rates);
      downloadedCount++;
    } catch (error) {
      downloadedCount++;
    }
  }

  console.log('\n\n=== Running Backtest ===\n');

  const adapter = createBacktestAdapter(candleData as any, fundingData, TOP_50_SYMBOLS);
  const coreTrendStrategy = new CoreTrendStrategy();
  const squeezeStrategy = new SqueezeStrategy();
  const fundingOverlay = new FundingOverlay();

  const timestamps = new Set<number>();
  const startTime = CONFIG.startDate.getTime();
  for (const [key, candles] of candleData.entries()) {
    if (key.endsWith('_4h') || key.endsWith('_15m')) {
      candles.filter(c => c.closeTime >= startTime).forEach(c => timestamps.add(c.closeTime));
    }
  }
  const sortedTimestamps = Array.from(timestamps).sort((a, b) => a - b);

  const openPositions = new Map<string, SimTrade>();
  const closedTrades: SimTrade[] = [];
  let balance = CONFIG.initialBalance;
  let peakBalance = CONFIG.initialBalance;
  let maxDrawdown = 0;

  for (let i = 0; i < sortedTimestamps.length; i++) {
    const timestamp = sortedTimestamps[i];
    adapter.setCurrentTime(timestamp);

    if (i % 2000 === 0) {
      const progress = Math.round((i / sortedTimestamps.length) * 100);
      const dateStr = new Date(timestamp).toISOString().split('T')[0];
      process.stdout.write('\rProgress: ' + progress + '% (' + dateStr + ') | Balance: $' + balance.toFixed(2) + ' | Positions: ' + openPositions.size + '    ');
    }

    // Check positions
    for (const [posKey, trade] of openPositions.entries()) {
      const currentPrice = adapter.getCurrentPrice(trade.symbol);
      if (!currentPrice) continue;

      const isLong = trade.direction === 'LONG';
      let shouldClose = false;
      let closeReason = '';
      let exitPrice = currentPrice;

      const effectiveSl = trade.tp1Hit && trade.trailingSl ? trade.trailingSl : trade.slPrice;

      if (isLong && currentPrice <= effectiveSl) {
        shouldClose = true;
        closeReason = trade.tp1Hit ? 'TRAILING_SL' : 'SL';
        exitPrice = effectiveSl * (1 - SLIPPAGE_RATE);
      } else if (!isLong && currentPrice >= effectiveSl) {
        shouldClose = true;
        closeReason = trade.tp1Hit ? 'TRAILING_SL' : 'SL';
        exitPrice = effectiveSl * (1 + SLIPPAGE_RATE);
      }

      if (!shouldClose && !trade.tp1Hit) {
        const tp1Reached = isLong ? currentPrice >= trade.tp1Price : currentPrice <= trade.tp1Price;
        if (tp1Reached) {
          const tp1ExitPrice = trade.tp1Price * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
          const tp1QtyPct = trade.signal.tp1QtyPercent;
          const tp1Size = trade.initialSizeUsd * tp1QtyPct;
          const tp1Pnl = calculatePnl(trade.entryPrice, tp1ExitPrice, tp1Size, trade.direction);
          trade.realizedPnlUsd += tp1Pnl.pnlUsd;
          trade.remainingSizeUsd = trade.initialSizeUsd - tp1Size;
          trade.tp1Hit = true;
          trade.slPrice = trade.entryPrice;
          const atr = trade.signal.metadata?.atr as number || (trade.entryPrice * 0.02);
          trade.trailingSl = isLong ? currentPrice - (atr * trade.signal.trailAtrMult) : currentPrice + (atr * trade.signal.trailAtrMult);
          balance += tp1Pnl.pnlUsd;
        }
      }

      if (!shouldClose && trade.tp1Hit && trade.trailingSl) {
        const atr = trade.signal.metadata?.atr as number || (trade.entryPrice * 0.02);
        if (isLong) {
          const newTs = currentPrice - (atr * trade.signal.trailAtrMult);
          if (newTs > trade.trailingSl) trade.trailingSl = newTs;
        } else {
          const newTs = currentPrice + (atr * trade.signal.trailAtrMult);
          if (newTs < trade.trailingSl) trade.trailingSl = newTs;
        }
      }

      if (!shouldClose && trade.signal.timeStopBars) {
        const barMs = trade.strategy === 'CORE_TREND' ? 4*60*60*1000 : 15*60*1000;
        if (Math.floor((timestamp - trade.entryTime) / barMs) >= trade.signal.timeStopBars) {
          shouldClose = true;
          closeReason = 'TIME_STOP';
          exitPrice = currentPrice * (1 + SLIPPAGE_RATE * (isLong ? -1 : 1));
        }
      }

      if (shouldClose) {
        const remainingPnl = calculatePnl(trade.entryPrice, exitPrice, trade.remainingSizeUsd, trade.direction);
        const fundingCost = adapter.calculateFundingCost(trade.symbol, trade.initialSizeUsd, trade.entryTime, timestamp, trade.direction);
        trade.exitPrice = exitPrice;
        trade.exitTime = timestamp;
        trade.pnlUsd = trade.realizedPnlUsd + remainingPnl.pnlUsd - fundingCost;
        trade.closeReason = closeReason;
        balance += remainingPnl.pnlUsd - fundingCost;
        closedTrades.push(trade);
        openPositions.delete(posKey);
      }
    }

    // Track drawdown
    if (balance > peakBalance) peakBalance = balance;
    const dd = (peakBalance - balance) / peakBalance;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // Generate signals
    for (const symbol of TOP_50_SYMBOLS) {
      if (openPositions.has(symbol)) continue;
      if (openPositions.size >= 6) continue;

      let signal: TradingSignal | null = coreTrendStrategy.generateSignal(symbol, adapter);
      if (!signal) signal = squeezeStrategy.generateSignal(symbol, adapter);

      if (signal?.detected) {
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
        openPositions.set(symbol, {
          symbol, strategy: finalSignal.strategyType, direction: finalSignal.direction,
          entryPrice, slPrice: finalSignal.slPrice, tp1Price: finalSignal.tp1Price,
          entryTime: timestamp, initialSizeUsd: positionSizeUsd, remainingSizeUsd: positionSizeUsd,
          realizedPnlUsd: 0, tp1Hit: false, signal: finalSignal,
        });
      }
    }
  }

  // Close remaining
  for (const [, trade] of openPositions.entries()) {
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

  // Results
  console.log('\n\n==========================================');
  console.log('  BACKTEST RESULTS');
  console.log('==========================================\n');

  const wins = closedTrades.filter(t => t.pnlUsd! > 0);
  const losses = closedTrades.filter(t => t.pnlUsd! <= 0);
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnlUsd!, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd!, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd!, 0));
  const tp1Hits = closedTrades.filter(t => t.tp1Hit);

  const coreTrendTrades = closedTrades.filter(t => t.strategy === 'CORE_TREND');
  const squeezeTrades = closedTrades.filter(t => t.strategy === 'SQUEEZE');

  console.log('📊 Summary');
  console.log('─────────────────────────────────────');
  console.log('Total Trades:     ' + closedTrades.length);
  console.log('Win Rate:         ' + (wins.length / closedTrades.length * 100).toFixed(1) + '%');
  console.log('Initial Balance:  $' + CONFIG.initialBalance.toFixed(2));
  console.log('Final Balance:    $' + balance.toFixed(2));
  console.log('Total P&L:        $' + totalPnl.toFixed(2));
  console.log('Return:           ' + ((balance - CONFIG.initialBalance) / CONFIG.initialBalance * 100).toFixed(2) + '%');
  console.log('Max Drawdown:     ' + (maxDrawdown * 100).toFixed(1) + '%');
  console.log('Profit Factor:    ' + (grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞'));
  console.log('TP1 Hit Rate:     ' + (tp1Hits.length / closedTrades.length * 100).toFixed(1) + '%');

  console.log('\n📈 By Strategy');
  console.log('─────────────────────────────────────');
  console.log('Core Trend: ' + coreTrendTrades.length + ' trades, $' + coreTrendTrades.reduce((s,t) => s + t.pnlUsd!, 0).toFixed(2) + ' P&L');
  console.log('Squeeze:    ' + squeezeTrades.length + ' trades, $' + squeezeTrades.reduce((s,t) => s + t.pnlUsd!, 0).toFixed(2) + ' P&L');

  console.log('\n📉 By Exit Reason');
  console.log('─────────────────────────────────────');
  const reasons = new Map<string, { count: number; pnl: number }>();
  for (const t of closedTrades) {
    const r = t.closeReason || 'UNKNOWN';
    if (!reasons.has(r)) reasons.set(r, { count: 0, pnl: 0 });
    reasons.get(r)!.count++;
    reasons.get(r)!.pnl += t.pnlUsd!;
  }
  for (const [reason, data] of reasons) {
    console.log(reason.padEnd(15) + ' ' + data.count.toString().padStart(4) + ' trades, $' + data.pnl.toFixed(2));
  }

  console.log('\n💰 Top 10 Winners');
  console.log('─────────────────────────────────────');
  const sortedByPnl = [...closedTrades].sort((a, b) => b.pnlUsd! - a.pnlUsd!);
  for (const t of sortedByPnl.slice(0, 10)) {
    console.log(t.symbol.padEnd(12) + ' ' + t.direction.padEnd(5) + ' $' + t.pnlUsd!.toFixed(2).padStart(8) + ' (' + t.closeReason + ')');
  }

  console.log('\n📉 Top 10 Losers');
  console.log('─────────────────────────────────────');
  for (const t of sortedByPnl.slice(-10).reverse()) {
    console.log(t.symbol.padEnd(12) + ' ' + t.direction.padEnd(5) + ' $' + t.pnlUsd!.toFixed(2).padStart(8) + ' (' + t.closeReason + ')');
  }

  // Monthly breakdown
  console.log('\n📅 Monthly Breakdown');
  console.log('─────────────────────────────────────');
  const monthly = new Map<string, { trades: number; pnl: number }>();
  for (const t of closedTrades) {
    const month = new Date(t.exitTime!).toISOString().slice(0, 7);
    if (!monthly.has(month)) monthly.set(month, { trades: 0, pnl: 0 });
    monthly.get(month)!.trades++;
    monthly.get(month)!.pnl += t.pnlUsd!;
  }
  for (const [month, data] of [...monthly].sort()) {
    console.log(month + ': ' + data.trades.toString().padStart(3) + ' trades, $' + data.pnl.toFixed(2));
  }
}

main().catch(console.error);
