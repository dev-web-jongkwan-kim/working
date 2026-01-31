/**
 * Live Action Executor
 *
 * Implements IActionExecutor for live trading.
 * Executes real orders via Binance API.
 *
 * Key features:
 * - Real-time order execution with proper error handling
 * - SL/TP order management on exchange
 * - Funding cost calculation from live API
 * - Position reconciliation support
 */

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IActionExecutor,
  PositionContext,
  CloseResult,
  FundingCostResult,
} from './action-executor.interface';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { DataCacheService } from '../../../dual-strategy/services/data/data-cache.service';
import { ExchangeInfoService } from '../../../dual-strategy/services/data/exchange-info.service';
import * as crypto from 'crypto';

export interface LiveExecutorConfig {
  /** Commission rate for PnL estimation (actual may differ) */
  commissionRate: number;

  /** Expected slippage for market orders */
  slippageRate: number;

  /** Retry attempts for failed orders */
  maxRetries: number;

  /** Delay between retries (ms) */
  retryDelayMs: number;
}

const DEFAULT_CONFIG: LiveExecutorConfig = {
  commissionRate: 0.0005, // 0.05%
  slippageRate: 0.0005, // 0.05% (market orders have more slippage)
  maxRetries: 3,
  retryDelayMs: 1000,
};

@Injectable()
export class LiveActionExecutor implements IActionExecutor {
  private config: LiveExecutorConfig;
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: CustomLoggerService,
    private readonly cacheService: DataCacheService,
    private readonly exchangeInfo: ExchangeInfoService,
  ) {
    this.config = DEFAULT_CONFIG;
    this.apiKey = this.configService.get('BINANCE_API_KEY') || '';
    this.apiSecret = this.configService.get('BINANCE_SECRET_KEY') || '';
    const isTestnet =
      this.configService.get('BINANCE_TESTNET', 'false') === 'true';
    this.baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  /**
   * Close a partial position
   */
  async closePartial(
    ctx: PositionContext,
    percent: number,
    price: number,
    reason: string,
  ): Promise<CloseResult> {
    this.logger.log(
      `[LiveActionExecutor] Closing ${percent}% of ${ctx.symbol} position (reason: ${reason})`,
      'LiveActionExecutor',
    );

    try {
      // Calculate quantity to close
      const closeSizeUsd = ctx.remainingSizeUsd * (percent / 100);
      const closeQuantity = closeSizeUsd / price;

      // Round to exchange precision
      const { quantityPrecision, pricePrecision } =
        await this.exchangeInfo.getSymbolPrecision(ctx.symbol);
      const roundedQuantity = this.roundToDecimals(
        closeQuantity,
        quantityPrecision,
      );

      // Place market close order
      const side = ctx.direction === 'LONG' ? 'SELL' : 'BUY';
      const result = await this.placeMarketOrder(
        ctx.symbol,
        side,
        roundedQuantity,
        true, // reduceOnly
      );

      if (!result.success) {
        return {
          pnl: 0,
          exitPrice: price,
          closedSizeUsd: 0,
          success: false,
          error: result.error,
        };
      }

      // Calculate realized PnL
      const exitPrice = result.avgPrice || price;
      const isLong = ctx.direction === 'LONG';
      const priceDiff = isLong
        ? exitPrice - ctx.entryPrice
        : ctx.entryPrice - exitPrice;
      const pnl = (priceDiff / ctx.entryPrice) * closeSizeUsd;
      const commission = closeSizeUsd * this.config.commissionRate;

      this.logger.log(
        `[LiveActionExecutor] Partial close success: ${roundedQuantity} @ ${exitPrice}, PnL: $${(pnl - commission).toFixed(2)}`,
        'LiveActionExecutor',
      );

      return {
        pnl: pnl - commission,
        exitPrice,
        closedSizeUsd: closeSizeUsd,
        success: true,
      };
    } catch (error) {
      this.logger.error(
        `[LiveActionExecutor] Partial close failed: ${error.message}`,
        error.stack,
        'LiveActionExecutor',
      );
      return {
        pnl: 0,
        exitPrice: price,
        closedSizeUsd: 0,
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Move stop loss to breakeven
   */
  async moveSLToBreakeven(ctx: PositionContext): Promise<PositionContext> {
    this.logger.log(
      `[LiveActionExecutor] Moving SL to breakeven for ${ctx.symbol}`,
      'LiveActionExecutor',
    );

    const result = await this.updateSLOnExchange(ctx, ctx.entryPrice);

    if (result.success) {
      return {
        ...ctx,
        slPrice: ctx.entryPrice,
      };
    }

    // Even if exchange update fails, update local state
    // Position reconciler will sync later
    this.logger.warn(
      `[LiveActionExecutor] Failed to update SL on exchange, updating local state only`,
      'LiveActionExecutor',
    );

    return {
      ...ctx,
      slPrice: ctx.entryPrice,
    };
  }

  /**
   * Update trailing stop price
   */
  async updateTrailingStop(
    ctx: PositionContext,
    newPrice: number,
  ): Promise<PositionContext> {
    const isLong = ctx.direction === 'LONG';

    // Only update if better (higher for long, lower for short)
    if (ctx.trailingStopPrice !== undefined) {
      if (isLong && newPrice <= ctx.trailingStopPrice) {
        return ctx;
      }
      if (!isLong && newPrice >= ctx.trailingStopPrice) {
        return ctx;
      }
    }

    this.logger.debug(
      `[LiveActionExecutor] Updating trailing stop for ${ctx.symbol}: ${ctx.trailingStopPrice} -> ${newPrice}`,
      'LiveActionExecutor',
    );

    // Update on exchange
    const result = await this.updateSLOnExchange(ctx, newPrice);

    if (result.success) {
      return {
        ...ctx,
        trailingStopPrice: newPrice,
        slPrice: newPrice, // Trailing stop becomes the effective SL
      };
    }

    // Update local state even if exchange fails
    return {
      ...ctx,
      trailingStopPrice: newPrice,
    };
  }

  /**
   * Close entire position
   */
  async closeAll(
    ctx: PositionContext,
    price: number,
    reason: string,
  ): Promise<CloseResult> {
    this.logger.log(
      `[LiveActionExecutor] Closing ALL of ${ctx.symbol} position (reason: ${reason})`,
      'LiveActionExecutor',
    );

    try {
      // Calculate quantity
      const closeQuantity = ctx.remainingSizeUsd / price;

      // Round to exchange precision
      const { quantityPrecision } = await this.exchangeInfo.getSymbolPrecision(
        ctx.symbol,
      );
      const roundedQuantity = this.roundToDecimals(
        closeQuantity,
        quantityPrecision,
      );

      // Place market close order
      const side = ctx.direction === 'LONG' ? 'SELL' : 'BUY';
      const result = await this.placeMarketOrder(
        ctx.symbol,
        side,
        roundedQuantity,
        true, // reduceOnly
      );

      if (!result.success) {
        return {
          pnl: 0,
          exitPrice: price,
          closedSizeUsd: 0,
          success: false,
          error: result.error,
        };
      }

      // Cancel any remaining SL/TP orders
      await this.cancelAllOrders(ctx.symbol);

      // Calculate realized PnL
      const exitPrice = result.avgPrice || price;
      const isLong = ctx.direction === 'LONG';
      const priceDiff = isLong
        ? exitPrice - ctx.entryPrice
        : ctx.entryPrice - exitPrice;
      const pnl = (priceDiff / ctx.entryPrice) * ctx.remainingSizeUsd;
      const commission = ctx.remainingSizeUsd * this.config.commissionRate;

      this.logger.log(
        `[LiveActionExecutor] Full close success: ${roundedQuantity} @ ${exitPrice}, PnL: $${(pnl - commission).toFixed(2)}`,
        'LiveActionExecutor',
      );

      return {
        pnl: pnl - commission,
        exitPrice,
        closedSizeUsd: ctx.remainingSizeUsd,
        success: true,
      };
    } catch (error) {
      this.logger.error(
        `[LiveActionExecutor] Full close failed: ${error.message}`,
        error.stack,
        'LiveActionExecutor',
      );
      return {
        pnl: 0,
        exitPrice: price,
        closedSizeUsd: 0,
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Calculate funding cost for a position
   */
  async calculateFundingCost(
    symbol: string,
    sizeUsd: number,
    entryTime: number,
    exitTime: number,
    direction: 'LONG' | 'SHORT',
  ): Promise<FundingCostResult> {
    const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

    try {
      // Fetch funding rate history from Binance
      const fundingHistory = await this.fetchFundingHistory(
        symbol,
        entryTime,
        exitTime,
      );

      if (fundingHistory.length === 0) {
        return { totalCost: 0, periods: 0, avgRate: 0 };
      }

      // Calculate total funding cost
      let totalCost = 0;
      for (const rate of fundingHistory) {
        const periodCost =
          direction === 'LONG' ? sizeUsd * rate : sizeUsd * -rate;
        totalCost += periodCost;
      }

      const avgRate =
        fundingHistory.reduce((a, b) => a + b, 0) / fundingHistory.length;

      return {
        totalCost,
        periods: fundingHistory.length,
        avgRate,
      };
    } catch (error) {
      this.logger.warn(
        `[LiveActionExecutor] Failed to calculate funding cost: ${error.message}`,
        'LiveActionExecutor',
      );
      return { totalCost: 0, periods: 0, avgRate: 0 };
    }
  }

  /**
   * Update SL order on exchange
   */
  async updateSLOnExchange(
    ctx: PositionContext,
    newSlPrice: number,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Cancel existing SL order first
      await this.cancelStopOrders(ctx.symbol, ctx.direction);

      // Place new SL order
      const side = ctx.direction === 'LONG' ? 'SELL' : 'BUY';
      const { pricePrecision, quantityPrecision } =
        await this.exchangeInfo.getSymbolPrecision(ctx.symbol);

      const roundedPrice = this.roundToDecimals(newSlPrice, pricePrecision);
      const currentPrice = await this.getCurrentPrice(ctx.symbol);
      if (!currentPrice) {
        return { success: false, error: 'Could not get current price' };
      }

      const quantity = ctx.remainingSizeUsd / currentPrice;
      const roundedQuantity = this.roundToDecimals(quantity, quantityPrecision);

      const result = await this.placeStopMarketOrder(
        ctx.symbol,
        side,
        roundedQuantity,
        roundedPrice,
        true, // reduceOnly
      );

      return result;
    } catch (error) {
      this.logger.error(
        `[LiveActionExecutor] Failed to update SL on exchange: ${error.message}`,
        error.stack,
        'LiveActionExecutor',
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current price from cache
   */
  async getCurrentPrice(symbol: string): Promise<number | null> {
    return await this.cacheService.getCurrentPrice(symbol);
  }

  // ==================== Private Methods ====================

  /**
   * Place market order
   */
  private async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    reduceOnly: boolean,
  ): Promise<{ success: boolean; avgPrice?: number; error?: string }> {
    const timestamp = Date.now();
    const params: Record<string, any> = {
      symbol,
      side,
      type: 'MARKET',
      quantity: quantity.toString(),
      reduceOnly: reduceOnly.toString(),
      timestamp,
    };

    const queryString = new URLSearchParams(params).toString();
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': this.apiKey,
          },
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.msg || `HTTP ${response.status}`);
        }

        return {
          success: true,
          avgPrice: parseFloat(data.avgPrice),
        };
      } catch (error) {
        if (attempt < this.config.maxRetries - 1) {
          await this.sleep(this.config.retryDelayMs);
        } else {
          return { success: false, error: error.message };
        }
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }

  /**
   * Place stop market order
   */
  private async placeStopMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    stopPrice: number,
    reduceOnly: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    const timestamp = Date.now();
    const params: Record<string, any> = {
      symbol,
      side,
      type: 'STOP_MARKET',
      quantity: quantity.toString(),
      stopPrice: stopPrice.toString(),
      reduceOnly: reduceOnly.toString(),
      timestamp,
    };

    const queryString = new URLSearchParams(params).toString();
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.msg || `HTTP ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel all open orders for a symbol
   */
  private async cancelAllOrders(symbol: string): Promise<void> {
    const timestamp = Date.now();
    const params = { symbol, timestamp };
    const queryString = new URLSearchParams(params as any).toString();
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}/fapi/v1/allOpenOrders?${queryString}&signature=${signature}`;

    try {
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });
    } catch (error) {
      this.logger.warn(
        `[LiveActionExecutor] Failed to cancel all orders: ${error.message}`,
        'LiveActionExecutor',
      );
    }
  }

  /**
   * Cancel stop orders for a position
   */
  private async cancelStopOrders(
    symbol: string,
    direction: 'LONG' | 'SHORT',
  ): Promise<void> {
    try {
      // Get all open orders
      const timestamp = Date.now();
      const params = { symbol, timestamp };
      const queryString = new URLSearchParams(params as any).toString();
      const signature = this.sign(queryString);
      const url = `${this.baseUrl}/fapi/v1/openOrders?${queryString}&signature=${signature}`;

      const response = await fetch(url, {
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      const orders = await response.json();

      // Cancel stop orders for the position side
      const stopSide = direction === 'LONG' ? 'SELL' : 'BUY';
      for (const order of orders) {
        if (
          order.type.includes('STOP') &&
          order.side === stopSide &&
          order.reduceOnly
        ) {
          await this.cancelOrder(symbol, order.orderId);
        }
      }
    } catch (error) {
      this.logger.warn(
        `[LiveActionExecutor] Failed to cancel stop orders: ${error.message}`,
        'LiveActionExecutor',
      );
    }
  }

  /**
   * Cancel single order
   */
  private async cancelOrder(symbol: string, orderId: number): Promise<void> {
    const timestamp = Date.now();
    const params = { symbol, orderId, timestamp };
    const queryString = new URLSearchParams(params as any).toString();
    const signature = this.sign(queryString);
    const url = `${this.baseUrl}/fapi/v1/order?${queryString}&signature=${signature}`;

    await fetch(url, {
      method: 'DELETE',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });
  }

  /**
   * Fetch funding rate history
   */
  private async fetchFundingHistory(
    symbol: string,
    startTime: number,
    endTime: number,
  ): Promise<number[]> {
    try {
      const url = `${this.baseUrl}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`;

      const response = await fetch(url);
      const data = await response.json();

      if (!Array.isArray(data)) {
        return [];
      }

      return data.map((f: any) => parseFloat(f.fundingRate));
    } catch (error) {
      return [];
    }
  }

  /**
   * Sign request with HMAC SHA256
   */
  private sign(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * Round to specified decimal places
   */
  private roundToDecimals(value: number, decimals: number): number {
    const multiplier = Math.pow(10, decimals);
    return Math.floor(value * multiplier) / multiplier;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
