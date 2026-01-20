/**
 * Common configuration for both strategies
 */

export const COMMON_CONFIG = {
  // Supported symbols (add more as needed)
  symbols: [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'ADAUSDT',
    'DOGEUSDT',
    'MATICUSDT',
    'DOTUSDT',
    'AVAXUSDT',
  ],

  // Timeframes to collect
  timeframes: ['1m', '5m', '15m', '1h'] as const,

  // General filters
  filters: {
    minLiquidity: 1000000, // $1M minimum daily volume
    maxSpreadPercent: 0.001, // 0.1% max spread
    minPriceUsd: 0.01, // Minimum price $0.01
  },

  // Binance API
  binance: {
    testnet: true, // Set to false for production
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
  },
};
