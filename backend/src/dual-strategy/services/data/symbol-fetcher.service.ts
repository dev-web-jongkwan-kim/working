import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

interface BinanceTicker {
  symbol: string;
  quoteVolume: string;
  volume: string;
  count: number; // Number of trades in 24h
  lastPrice: string;
}

/**
 * Symbol Fetcher Service
 * Fetches top trading volume symbols from Binance
 */
@Injectable()
export class SymbolFetcherService {
  private cachedSymbols: string[] = [];
  private lastFetchTime: number = 0;
  private readonly CACHE_DURATION = 3600000; // 1 hour
  private isTestnet: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: CustomLoggerService,
  ) {
    this.isTestnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';
  }

  /**
   * Get top N symbols by 24h volume
   */
  async getTopSymbols(count: number = 100): Promise<string[]> {
    // Return cached symbols if still fresh
    const now = Date.now();
    if (this.cachedSymbols.length > 0 && now - this.lastFetchTime < this.CACHE_DURATION) {
      this.logger.log(`Using cached symbols (${this.cachedSymbols.length})`, 'SymbolFetcher');
      return this.cachedSymbols.slice(0, count);
    }

    try {
      this.logger.log(`Fetching top ${count} symbols from Binance...`, 'SymbolFetcher');

      const baseUrl = this.isTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com';

      // STEP 1: Get exchange info to filter only TRADING symbols
      const exchangeInfoResponse = await fetch(`${baseUrl}/fapi/v1/exchangeInfo`);
      if (!exchangeInfoResponse.ok) {
        throw new Error(`Exchange info HTTP ${exchangeInfoResponse.status}`);
      }

      const exchangeInfo = await exchangeInfoResponse.json();
      const tradingSymbols = new Set(
        exchangeInfo.symbols
          .filter((s: any) => s.status === 'TRADING' && s.symbol.endsWith('USDT'))
          .map((s: any) => s.symbol)
      );

      this.logger.log(
        `Found ${tradingSymbols.size} TRADING symbols (filtered from ${exchangeInfo.symbols.length} total)`,
        'SymbolFetcher',
      );

      // STEP 2: Get 24h ticker data for all symbols
      const response = await fetch(`${baseUrl}/fapi/v1/ticker/24hr`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const tickers: BinanceTicker[] = await response.json();

      // STEP 3: Filter and rank TRADING symbols only
      const usdtSymbols = tickers
        .filter(t => t.symbol.endsWith('USDT'))
        .filter(t => tradingSymbols.has(t.symbol)) // CRITICAL: Only TRADING status symbols
        .map(t => ({
          symbol: t.symbol,
          quoteVolume: parseFloat(t.quoteVolume),
          volume: parseFloat(t.volume),
          count: t.count,
          lastPrice: parseFloat(t.lastPrice),
        }))
        // CRITICAL: Filter symbols with RECENT trading activity
        .filter(t => {
          // Must have recent trades (count > 0)
          if (t.count === 0) return false;

          // Must have volume (both base and quote)
          if (t.volume === 0 || t.quoteVolume === 0) return false;

          // Must have valid price
          if (isNaN(t.lastPrice) || t.lastPrice === 0) return false;

          return true;
        })
        // Sort by quote volume (USDT trading volume)
        // Now safe to use since we filtered out SETTLING symbols
        .sort((a, b) => b.quoteVolume - a.quoteVolume)
        .slice(0, count)
        .map(t => t.symbol);

      this.cachedSymbols = usdtSymbols;
      this.lastFetchTime = now;

      this.logger.log(
        `Successfully fetched ${usdtSymbols.length} TRADING symbols (sorted by volume). Top 10: ${usdtSymbols.slice(0, 10).join(', ')}`,
        'SymbolFetcher',
      );

      return usdtSymbols;
    } catch (error) {
      this.logger.error(
        `Failed to fetch symbols from Binance: ${error.message}`,
        error.stack,
        'SymbolFetcher',
      );

      // Return fallback symbols if fetch fails
      const fallbackSymbols = [
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
        'LINKUSDT',
        'ATOMUSDT',
        'UNIUSDT',
        'LTCUSDT',
        'TRXUSDT',
      ];

      this.logger.warn(
        `Using fallback symbols (${fallbackSymbols.length})`,
        'SymbolFetcher',
      );

      return fallbackSymbols;
    }
  }

  /**
   * Get current cached symbols
   */
  getCachedSymbols(): string[] {
    return this.cachedSymbols;
  }

  /**
   * Clear cache (force refresh on next fetch)
   */
  clearCache(): void {
    this.cachedSymbols = [];
    this.lastFetchTime = 0;
    this.logger.log('Symbol cache cleared', 'SymbolFetcher');
  }
}
