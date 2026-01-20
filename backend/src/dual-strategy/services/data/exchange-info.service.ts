import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';

export interface SymbolFilter {
  filterType: string;
  minPrice?: string;
  maxPrice?: string;
  tickSize?: string;
  minQty?: string;
  maxQty?: string;
  stepSize?: string;
  minNotional?: string;
}

export interface SymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  pricePrecision: number;
  quantityPrecision: number;
  baseAssetPrecision: number;
  quotePrecision: number;
  filters: SymbolFilter[];
}

export interface SymbolPrecision {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: string;
  stepSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
}

@Injectable()
export class ExchangeInfoService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeInfoService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly isTestnet: boolean;
  private readonly precisionCache: Map<string, SymbolPrecision> = new Map();

  constructor(
    private readonly configService: ConfigService,
  ) {
    this.isTestnet = this.configService.get<string>('BINANCE_TESTNET') === 'true';
    this.baseUrl = this.isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
    this.apiKey = this.configService.get<string>('BINANCE_API_KEY');
    this.apiSecret = this.configService.get<string>('BINANCE_API_SECRET');
  }

  async onModuleInit() {
    this.logger.log('Initializing ExchangeInfoService...');
    await this.fetchAndCacheExchangeInfo();
    this.logger.log('ExchangeInfoService initialized');
  }

  /**
   * 매일 자정에 Exchange Info 업데이트
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduledUpdate() {
    this.logger.log('Running scheduled exchange info update...');
    await this.fetchAndCacheExchangeInfo();
  }

  /**
   * 바이낸스 API에서 Exchange Info 가져와서 Redis에 캐싱
   */
  async fetchAndCacheExchangeInfo(): Promise<void> {
    try {
      const url = `${this.baseUrl}/fapi/v1/exchangeInfo`;

      this.logger.log('Fetching exchange info from Binance...');
      const response = await fetch(url, {
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch exchange info: ${response.statusText}`);
      }

      const data = await response.json();
      const symbols: SymbolInfo[] = data.symbols;

      // USDT 마켓만 필터링
      const usdtSymbols = symbols.filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING');

      this.logger.log(`Found ${usdtSymbols.length} USDT trading pairs`);

      // Store in memory cache
      for (const symbol of usdtSymbols) {
        const precision = this.extractPrecision(symbol);
        this.precisionCache.set(symbol.symbol, precision);
      }

      this.logger.log(`Cached precision data for ${usdtSymbols.length} symbols`);
    } catch (error) {
      this.logger.error(
        `Failed to fetch and cache exchange info: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * SymbolInfo에서 필요한 정밀도 정보 추출
   */
  private extractPrecision(symbolInfo: SymbolInfo): SymbolPrecision {
    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL');

    return {
      symbol: symbolInfo.symbol,
      pricePrecision: symbolInfo.pricePrecision,
      quantityPrecision: symbolInfo.quantityPrecision,
      tickSize: priceFilter?.tickSize || '0.01',
      stepSize: lotSizeFilter?.stepSize || '0.001',
      minQty: lotSizeFilter?.minQty || '0.001',
      maxQty: lotSizeFilter?.maxQty || '1000000',
      minNotional: minNotionalFilter?.minNotional || '5',
    };
  }

  /**
   * 심볼의 정밀도 정보 가져오기
   */
  async getSymbolPrecision(symbol: string): Promise<SymbolPrecision | null> {
    try {
      const cached = this.precisionCache.get(symbol);

      if (cached) {
        return cached;
      }

      // 캐시에 없으면 API 호출해서 가져오기
      this.logger.warn(`Precision not found in cache for ${symbol}, fetching...`);
      await this.fetchAndCacheExchangeInfo();

      const refreshed = this.precisionCache.get(symbol);
      if (refreshed) {
        return refreshed;
      }

      this.logger.error(`Failed to get precision for ${symbol} even after refresh`);
      return null;
    } catch (error) {
      this.logger.error(
        `Error getting symbol precision for ${symbol}: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * 수량을 stepSize에 맞게 반올림
   */
  async roundQuantity(quantity: number, symbol: string): Promise<number> {
    const precision = await this.getSymbolPrecision(symbol);
    if (!precision) {
      this.logger.warn(`No precision data for ${symbol}, using default 0.001`);
      return Math.floor(quantity * 1000) / 1000;
    }

    const stepSize = parseFloat(precision.stepSize);
    const rounded = Math.floor(quantity / stepSize) * stepSize;

    // stepSize의 소수점 자릿수만큼 반올림
    const decimals = this.countDecimals(stepSize);
    return parseFloat(rounded.toFixed(decimals));
  }

  /**
   * 가격을 tickSize에 맞게 반올림
   */
  async roundPrice(price: number, symbol: string): Promise<number> {
    const precision = await this.getSymbolPrecision(symbol);
    if (!precision) {
      this.logger.warn(`No precision data for ${symbol}, using default 0.01`);
      return Math.round(price * 100) / 100;
    }

    const tickSize = parseFloat(precision.tickSize);
    const rounded = Math.round(price / tickSize) * tickSize;

    // tickSize의 소수점 자릿수만큼 반올림
    const decimals = this.countDecimals(tickSize);
    return parseFloat(rounded.toFixed(decimals));
  }

  /**
   * 최소 주문 수량 체크
   */
  async isValidQuantity(quantity: number, symbol: string): Promise<boolean> {
    const precision = await this.getSymbolPrecision(symbol);
    if (!precision) {
      return false;
    }

    const minQty = parseFloat(precision.minQty);
    const maxQty = parseFloat(precision.maxQty);

    return quantity >= minQty && quantity <= maxQty;
  }

  /**
   * 최소 거래 금액(Notional) 체크
   */
  async isValidNotional(quantity: number, price: number, symbol: string): Promise<boolean> {
    const precision = await this.getSymbolPrecision(symbol);
    if (!precision) {
      return false;
    }

    const notional = quantity * price;
    const minNotional = parseFloat(precision.minNotional);

    return notional >= minNotional;
  }

  /**
   * 소수점 자릿수 계산
   */
  private countDecimals(value: number): number {
    const str = value.toString();
    if (str.includes('.')) {
      return str.split('.')[1].length;
    }
    return 0;
  }

  /**
   * 모든 심볼 목록 가져오기
   */
  async getAllSymbols(): Promise<string[]> {
    return Array.from(this.precisionCache.keys());
  }
}
