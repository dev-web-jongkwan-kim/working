import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Binance from 'binance-api-node';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';

@Injectable()
export class BinanceService implements OnModuleInit {
  private client: ReturnType<typeof Binance>;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: CustomLoggerService,
  ) {}

  onModuleInit() {
    const apiKey = this.configService.get('BINANCE_API_KEY');
    const apiSecret = this.configService.get('BINANCE_SECRET_KEY');
    const testnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';

    this.client = Binance({
      apiKey,
      apiSecret,
      ...(testnet && {
        httpFutures: 'https://testnet.binancefuture.com',
        wsFutures: 'wss://stream.binancefuture.com',
      }),
    });

    this.logger.log(
      `BinanceService initialized (${testnet ? 'TESTNET' : 'MAINNET'})`,
      'BinanceService'
    );
  }

  /**
   * Get funding rate for a symbol
   */
  async getFundingRate(symbol: string): Promise<number> {
    try {
      const fundingRates = await this.client.futuresFundingRate({ symbol, limit: 1 });
      if (fundingRates && fundingRates.length > 0) {
        return parseFloat(fundingRates[0].fundingRate);
      }
      return 0;
    } catch (error) {
      this.logger.warn(`Failed to get funding rate for ${symbol}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get funding rate history for a symbol
   * @param symbol Trading pair symbol (e.g., BTCUSDT)
   * @param limit Number of historical funding rates to fetch (max 1000)
   * @returns Array of funding rates, oldest first
   */
  async getFundingRateHistory(symbol: string, limit: number = 168): Promise<number[]> {
    try {
      // Binance returns newest first, we want oldest first for time series
      const fundingRates = await this.client.futuresFundingRate({
        symbol,
        limit: Math.min(limit, 1000) // Binance max is 1000
      });

      if (fundingRates && fundingRates.length > 0) {
        // Reverse to get oldest first, then extract just the rates
        return fundingRates
          .reverse()
          .map(f => parseFloat(f.fundingRate));
      }

      return [];
    } catch (error) {
      this.logger.warn(`Failed to get funding rate history for ${symbol}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get klines/candles
   */
  async getKlines(symbol: string, interval: any, limit: number): Promise<any[]> {
    try {
      const candles = await this.client.futuresCandles({
        symbol,
        interval,
        limit,
      });
      return candles;
    } catch (error) {
      this.logger.warn(`Failed to get klines for ${symbol}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get current open interest
   */
  async getOpenInterest(symbol: string): Promise<number> {
    try {
      const testnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';
      const baseUrl = testnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com';

      const response = await fetch(`${baseUrl}/fapi/v1/openInterest?symbol=${symbol}`);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return parseFloat(data.openInterest);
    } catch (error) {
      this.logger.warn(`Failed to get OI for ${symbol}: ${error.message}`);
      return 0;
    }
  }

  /**
   * Get open interest history
   */
  async getOpenInterestHistory(symbol: string, period: string, limit: number): Promise<any[]> {
    try {
      const testnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';
      const baseUrl = testnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com';

      const response = await fetch(
        `${baseUrl}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.warn(`Failed to get OI history for ${symbol}: ${error.message}`);
      return [];
    }
  }

  /**
   * Get 24hr ticker
   */
  async get24hrTicker(symbol: string): Promise<any> {
    try {
      const ticker = await this.client.futuresDailyStats({ symbol });
      return ticker;
    } catch (error) {
      this.logger.warn(`Failed to get 24hr ticker for ${symbol}: ${error.message}`);
      return { quoteVolume: '0', highPrice: '0', lowPrice: '0' };
    }
  }

  /**
   * Get symbol price ticker
   */
  async getSymbolPriceTicker(symbol: string): Promise<any> {
    try {
      const prices = await this.client.futuresPrices({ symbol });
      return { price: prices[symbol] || '0' };
    } catch (error) {
      this.logger.warn(`Failed to get price for ${symbol}: ${error.message}`);
      return { price: '0' };
    }
  }

  /**
   * Get leverage bracket
   */
  async getLeverageBracket(symbol: string): Promise<any[]> {
    try {
      const brackets = await this.client.futuresLeverageBracket({ symbol, recvWindow: 5000 });
      return brackets.find(b => b.symbol === symbol)?.brackets || [{ initialLeverage: 10 }];
    } catch (error) {
      this.logger.warn(`Failed to get leverage bracket for ${symbol}: ${error.message}`);
      return [{ initialLeverage: 10 }];
    }
  }

  /**
   * Set leverage
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.client.futuresLeverage({ symbol, leverage });
    } catch (error) {
      this.logger.warn(`Failed to set leverage for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Set margin type (ISOLATED/CROSSED)
   */
  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      await this.client.futuresMarginType({ symbol, marginType });
    } catch (error) {
      // Ignore error if already set
      if (!error.message.includes('No need to change margin type')) {
        this.logger.warn(`Failed to set margin type for ${symbol}: ${error.message}`);
      }
    }
  }

  /**
   * Place futures order
   */
  async futuresOrder(params: any): Promise<any> {
    try {
      const order = await this.client.futuresOrder(params);
      return order;
    } catch (error) {
      this.logger.error(`Failed to place order: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(symbol: string, orderId: number): Promise<void> {
    try {
      await this.client.futuresCancelOrder({ symbol, orderId });
    } catch (error) {
      this.logger.warn(`Failed to cancel order ${orderId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all open orders for a symbol
   */
  async getOpenOrders(symbol: string): Promise<any[]> {
    try {
      const orders = await this.client.futuresOpenOrders({ symbol });
      return orders || [];
    } catch (error) {
      this.logger.warn(`Failed to get open orders for ${symbol}: ${error.message}`);
      return [];
    }
  }

  /**
   * Cancel all open orders for a symbol
   */
  async cancelAllOrders(symbol: string): Promise<void> {
    try {
      await this.client.futuresCancelAllOpenOrders({ symbol });
      this.logger.log(`All open orders cancelled for ${symbol}`, 'BinanceService');
    } catch (error) {
      this.logger.warn(`Failed to cancel all orders for ${symbol}: ${error.message}`);
    }
  }

  /**
   * Get position risk (includes unrealized PNL and position details)
   */
  async getPositionRisk(symbol?: string): Promise<any[]> {
    try {
      const positions = await this.client.futuresPositionRisk(symbol ? { symbol } : {});
      return positions || [];
    } catch (error) {
      this.logger.warn(`Failed to get position risk: ${error.message}`);
      return [];
    }
  }

  /**
   * Get account information (includes all positions and balances)
   */
  async getAccountInfo(): Promise<any> {
    try {
      const account = await this.client.futuresAccountInfo();
      return account;
    } catch (error) {
      this.logger.warn(`Failed to get account info: ${error.message}`);
      return null;
    }
  }

  /**
   * Get futures listen key for user data stream
   * TODO: binance-api-node doesn't expose listen key methods, needs implementation
   */
  async getFuturesListenKey(): Promise<string> {
    this.logger.warn('getFuturesListenKey not implemented yet');
    return '';
  }

  /**
   * Keep alive futures listen key
   * TODO: binance-api-node doesn't expose keep alive, needs implementation
   */
  async keepAliveFuturesListenKey(listenKey: string): Promise<void> {
    this.logger.warn('keepAliveFuturesListenKey not implemented yet');
  }

  /**
   * Subscribe to futures user data stream
   * Using binance-api-node's ws.user method
   */
  futuresUserDataStream(listenKey: string, callback: (data: any) => void): void {
    try {
      this.client.ws.user((data: any) => {
        callback(data);
      });
    } catch (error) {
      this.logger.error(`Failed to subscribe to user data stream: ${error.message}`);
    }
  }
}
