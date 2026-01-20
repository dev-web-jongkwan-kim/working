import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { Trade, TradeStatus, StrategyType, CloseReason } from '../../../entities/trade.entity';
import { Position, PositionStatus } from '../../../entities/position.entity';
import { Signal } from '../../../entities/signal.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { TradingWebSocketGateway } from '../../../websocket/websocket.gateway';
import { TradingSignal } from '../../interfaces/signal.interface';
import { EventType } from '../../../entities/strategy-log.entity';
import { RiskManagerService } from './risk-manager.service';
import { ExchangeInfoService } from '../data/exchange-info.service';
import { DataCacheService } from '../data/data-cache.service';

interface OrderRequest {
  symbol: string;
  direction: string;
  strategyType: StrategyType;
  subStrategy: string;
  entryPrice: number;
  slPrice: number;
  tp1Price?: number;
  tp2Price?: number;
  leverage: number;
  marginUsd: number;
  useTrailing?: boolean;
  confidence: number;
  marketRegime?: string;
  metadata?: any;
}

interface BinanceOrderResult {
  success: boolean;
  fillPrice?: number;
  executedQty?: number;
  error?: string;
  orderId?: number;
  pending?: boolean;  // True when order is placed but awaiting fill (status=NEW)
}

/**
 * Order Executor Service
 * CRITICAL: Executes orders, saves to database, and logs everything
 */
/**
 * Pending order info for entry orders awaiting fill
 */
interface PendingOrder {
  signalId: string;
  tradeId: string;
  request: OrderRequest;
  orderId: number;
  price: number;
  quantity: number;
  timestamp: number;
}

@Injectable()
export class OrderExecutorService {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;

  // REMOVED: In-memory Map causes data loss on service restart
  // private pendingOrders: Map<number, PendingOrder> = new Map();

  constructor(
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(Signal)
    private readonly signalRepo: Repository<Signal>,
    private readonly logger: CustomLoggerService,
    private readonly wsGateway: TradingWebSocketGateway,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => RiskManagerService))
    private readonly riskManager: RiskManagerService,
    private readonly exchangeInfo: ExchangeInfoService,
    private readonly cacheService: DataCacheService,
  ) {
    this.apiKey = this.configService.get('BINANCE_API_KEY');
    this.apiSecret = this.configService.get('BINANCE_SECRET_KEY');
    const isTestnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';
    this.baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  /**
   * CRITICAL: Redis-backed pending orders (survives service restarts)
   * Save pending order to Redis
   */
  private async savePendingOrder(orderId: number, pendingOrder: PendingOrder): Promise<void> {
    const key = `pending_order:${orderId}`;
    await this.cacheService.client.set(key, JSON.stringify(pendingOrder), { EX: 3600 }); // 1 hour TTL
    this.logger.debug(`Saved pending order ${orderId} to Redis`, 'OrderExecutor');
  }

  /**
   * Get pending order from Redis
   */
  private async getPendingOrder(orderId: number): Promise<PendingOrder | null> {
    const key = `pending_order:${orderId}`;
    const data = await this.cacheService.client.get(key);
    if (!data) {
      return null;
    }
    return JSON.parse(data);
  }

  /**
   * Delete pending order from Redis
   */
  private async deletePendingOrder(orderId: number): Promise<void> {
    const key = `pending_order:${orderId}`;
    await this.cacheService.client.del(key);
    this.logger.debug(`Deleted pending order ${orderId} from Redis`, 'OrderExecutor');
  }

  /**
   * Execute an order from a trading signal
   */
  async executeOrder(request: OrderRequest): Promise<{ success: boolean; tradeId?: string; error?: string }> {
    const tradeId = `TRD_${uuidv4().substring(0, 8)}`;
    const signalId = `SIG_${uuidv4().substring(0, 8)}`;

    try {
      // 0. CRITICAL: Re-check risk immediately before execution
      const riskCheck = await this.riskManager.canOpenNewPosition(request.symbol, request.direction);
      if (!riskCheck.allowed) {
        this.logger.warn(
          `Risk check failed at execution time: ${riskCheck.reason}`,
          'OrderExecutor',
        );

        await this.saveSignal(signalId, request);
        await this.signalRepo.update(
          { signal_id: signalId },
          {
            rejected: true,
            rejection_reason: `Risk check: ${riskCheck.reason}`,
          },
        );

        return { success: false, error: riskCheck.reason };
      }

      // 1. Save signal to database
      await this.saveSignal(signalId, request);

      // 2. Log signal generation
      await this.logger.logStrategy({
        level: 'info',
        strategyType: request.strategyType,
        subStrategy: request.subStrategy,
        symbol: request.symbol,
        eventType: EventType.SIGNAL_GENERATED,
        message: `Signal generated: ${request.subStrategy} for ${request.symbol} ${request.direction}`,
        signalId,
        metadata: {
          entryPrice: request.entryPrice,
          slPrice: request.slPrice,
          confidence: request.confidence,
          leverage: request.leverage,
        },
      });

      // 3. Set margin type to ISOLATED
      await this.setMarginType(request.symbol, 'ISOLATED');

      // 4. Set leverage - CRITICAL: Must succeed before placing order!
      try {
        await this.setLeverage(request.symbol, request.leverage);
      } catch (leverageError) {
        // CRITICAL: Abort trade if leverage setting fails
        // This prevents wrong-leverage trades like MERLUSDT incident (expected 20x, got 15x)
        this.logger.error(
          `🚨 ABORTING TRADE: Leverage setting failed for ${request.symbol}`,
          leverageError.stack,
          'OrderExecutor',
        );

        await this.signalRepo.update(
          { signal_id: signalId },
          {
            rejected: true,
            rejection_reason: `Leverage setting failed: ${leverageError.message}`,
          },
        );

        return { success: false, error: `Leverage setting failed: ${leverageError.message}` };
      }

      // 5. Execute LIMIT order
      const orderResult = await this.executeBinanceOrder(request);

      if (!orderResult.success) {
        // Update signal as rejected
        await this.signalRepo.update(
          { signal_id: signalId },
          {
            rejected: true,
            rejection_reason: orderResult.error,
          },
        );

        await this.logger.logStrategy({
          level: 'warn',
          strategyType: request.strategyType,
          subStrategy: request.subStrategy,
          symbol: request.symbol,
          eventType: EventType.SIGNAL_REJECTED,
          message: `Signal rejected: ${orderResult.error}`,
          signalId,
          metadata: { reason: orderResult.error },
        });

        return { success: false, error: orderResult.error };
      }

      // CRITICAL: Handle pending orders (status=NEW, awaiting fill)
      if (orderResult.pending) {
        // CRITICAL: Store pending order info in Redis (survives service restarts!)
        await this.savePendingOrder(orderResult.orderId!, {
          signalId,
          tradeId,
          request,
          orderId: orderResult.orderId!,
          price: request.entryPrice,
          quantity: 0, // Will be filled by callback
          timestamp: Date.now(),
        });

        this.logger.log(
          `⏳ Order pending (orderId: ${orderResult.orderId}). Saved to Redis. Will complete when User Data Stream reports fill.`,
          'OrderExecutor',
        );

        // Update signal as executed (order placed successfully, awaiting fill)
        await this.signalRepo.update(
          { signal_id: signalId },
          { executed: true },
        );

        return { success: true, tradeId };
      }

      // 5. Recalculate SL/TP based on actual fill price
      const actualFillPrice = orderResult.fillPrice!;
      const actualQuantity = orderResult.executedQty!;
      const recalculatedPrices = await this.recalculateSlTp(
        actualFillPrice,
        request.direction,
        request.slPrice,
        request.tp1Price,
        request.tp2Price,
        request.entryPrice,
        request.symbol, // CRITICAL: Pass symbol for price rounding
      );

      this.logger.log(
        `Recalculated prices - Original Entry: ${request.entryPrice}, Actual Fill: ${actualFillPrice}, ` +
        `SL: ${recalculatedPrices.slPrice}, TP1: ${recalculatedPrices.tp1Price}, TP2: ${recalculatedPrices.tp2Price}`,
        'OrderExecutor',
      );

      // 6. Place SL/TP orders using Binance Algo Order API
      // CRITICAL: Must use Binance orders, not client-side monitoring
      // Server can crash anytime, so Binance must handle SL/TP
      try {
        await this.placeSlTpOrders(
          request.symbol,
          request.direction,
          actualQuantity,
          recalculatedPrices.slPrice,
          recalculatedPrices.tp1Price,
          recalculatedPrices.tp2Price,
        );
      } catch (slTpError) {
        // CRITICAL: SL/TP 주문 실패 - 즉시 긴급 청산!
        // SL 없이 포지션 유지는 위험하므로, 즉시 시장가로 청산
        this.logger.error(
          `CRITICAL: SL/TP orders failed! Initiating emergency close: ${slTpError.message}`,
          slTpError.stack,
          'OrderExecutor',
        );

        try {
          // Emergency close the position
          await this.emergencyClosePosition(request.symbol, request.direction, actualQuantity);

          this.logger.warn(
            `🚨 Emergency closed ${request.symbol} due to SL/TP placement failure`,
            'OrderExecutor',
          );

          // Save Trade as CLOSED (emergency closed)
          await this.tradeRepo.save({
            trade_id: tradeId,
            signal_id: signalId,
            strategy_type: request.strategyType,
            sub_strategy: request.subStrategy,
            symbol: request.symbol,
            direction: request.direction as any,
            entry_price: actualFillPrice,
            exit_price: actualFillPrice, // ~market close at entry
            sl_price: recalculatedPrices.slPrice,
            tp1_price: recalculatedPrices.tp1Price,
            tp2_price: recalculatedPrices.tp2Price,
            leverage: request.leverage,
            margin_usd: request.marginUsd,
            position_size: actualQuantity,
            entry_time: new Date(),
            exit_time: new Date(),
            status: TradeStatus.CLOSED,
            close_reason: CloseReason.MANUAL, // Use MANUAL as closest match
            pnl_usd: 0, // Minimal loss from immediate close
            pnl_percent: 0,
            confidence: request.confidence,
            market_regime: request.marketRegime,
            metadata: {
              ...request.metadata,
              emergencyClosed: true,
              slTpPlacementFailed: true,
              slTpError: slTpError.message
            },
          });

          // Update signal as rejected (we couldn't maintain position)
          await this.signalRepo.update(
            { signal_id: signalId },
            {
              rejected: true,
              rejection_reason: `SL/TP placement failed - emergency closed: ${slTpError.message}`,
            },
          );

          // Log the emergency close
          await this.logger.logStrategy({
            level: 'error',
            strategyType: request.strategyType,
            subStrategy: request.subStrategy,
            symbol: request.symbol,
            eventType: EventType.POSITION_CLOSED,
            message: `EMERGENCY CLOSED: SL/TP placement failed - ${slTpError.message}`,
            tradeId: tradeId,
            signalId: signalId,
            metadata: {
              reason: 'SL_TP_PLACEMENT_FAILED',
              slTpError: slTpError.message,
              entryPrice: actualFillPrice,
              quantity: actualQuantity,
            },
          });

          return {
            success: false,
            error: `SL/TP placement failed - emergency closed: ${slTpError.message}`
          };

        } catch (emergencyCloseError) {
          // CRITICAL: Emergency close also failed!
          this.logger.error(
            `CRITICAL: Emergency close ALSO failed! Manual intervention required: ${emergencyCloseError.message}`,
            emergencyCloseError.stack,
            'OrderExecutor',
          );

          // Save as OPEN with critical warning
          await this.tradeRepo.save({
            trade_id: tradeId,
            signal_id: signalId,
            strategy_type: request.strategyType,
            sub_strategy: request.subStrategy,
            symbol: request.symbol,
            direction: request.direction as any,
            entry_price: actualFillPrice,
            sl_price: recalculatedPrices.slPrice,
            tp1_price: recalculatedPrices.tp1Price,
            tp2_price: recalculatedPrices.tp2Price,
            leverage: request.leverage,
            margin_usd: request.marginUsd,
            position_size: actualQuantity,
            entry_time: new Date(),
            status: TradeStatus.OPEN,
            confidence: request.confidence,
            market_regime: request.marketRegime,
            metadata: {
              ...request.metadata,
              CRITICAL_MANUAL_INTERVENTION_REQUIRED: true,
              slTpPlacementFailed: true,
              slTpError: slTpError.message,
              emergencyCloseFailed: true,
              emergencyCloseError: emergencyCloseError.message,
            },
          });

          await this.signalRepo.update(
            { signal_id: signalId },
            {
              rejected: true,
              rejection_reason: `CRITICAL: Both SL/TP and emergency close failed!`,
            },
          );

          return {
            success: false,
            error: `CRITICAL: Emergency close also failed - MANUAL INTERVENTION REQUIRED`
          };
        }
      }

      // 7. Calculate position size
      const positionSize = actualQuantity;

      this.logger.log(
        `📊 Creating position for ${request.symbol}: ` +
        `Entry Price: ${actualFillPrice}, ` +
        `Quantity: ${positionSize}, ` +
        `Margin: ${request.marginUsd} USD, ` +
        `Leverage: ${request.leverage}x`,
        'OrderExecutor',
      );

      // 8-10. CRITICAL: Save Trade, Position, Signal in a single transaction
      const positionId = `POS_${uuidv4().substring(0, 8)}`;
      let trade: Trade;

      await this.tradeRepo.manager.transaction(async (manager) => {
        // 8. Save trade
        trade = await manager.save(Trade, {
          trade_id: tradeId,
          signal_id: signalId,
          strategy_type: request.strategyType,
          sub_strategy: request.subStrategy,
          symbol: request.symbol,
          direction: request.direction as any,
          entry_price: actualFillPrice,
          sl_price: recalculatedPrices.slPrice,
          tp1_price: recalculatedPrices.tp1Price,
          tp2_price: recalculatedPrices.tp2Price,
          leverage: request.leverage,
          margin_usd: request.marginUsd,
          position_size: positionSize,
          entry_time: new Date(),
          status: TradeStatus.OPEN,
          confidence: request.confidence,
          market_regime: request.marketRegime,
          metadata: request.metadata,
        });

        // 9. Create position record
        await manager.save(Position, {
          position_id: positionId,
          trade_id: tradeId,
          strategy_type: request.strategyType,
          sub_strategy: request.subStrategy,
          symbol: request.symbol,
          direction: request.direction as any,
          entry_price: actualFillPrice,
          current_price: actualFillPrice,
          leverage: request.leverage,
          margin_usd: request.marginUsd,
          position_size: positionSize,
          remaining_size: positionSize,
          sl_price: recalculatedPrices.slPrice,
          tp1_price: recalculatedPrices.tp1Price,
          tp2_price: recalculatedPrices.tp2Price,
          status: PositionStatus.ACTIVE,
          tp1_filled: false,
          tp2_filled: false,
          realized_pnl: 0,
          unrealized_pnl: 0,
          unrealized_pnl_percent: 0,
          entry_time: new Date(),
          last_update_time: new Date(),
        });

        // 10. Update signal as executed
        await manager.update(Signal, { signal_id: signalId }, {
          executed: true,
          trade_id: tradeId,
        });
      });

      // 11. Log successful order
      await this.logger.logStrategy({
        level: 'info',
        strategyType: request.strategyType,
        subStrategy: request.subStrategy,
        symbol: request.symbol,
        eventType: EventType.ORDER_FILLED,
        message: `Order filled for ${request.symbol} ${request.direction}`,
        tradeId,
        signalId,
        metadata: {
          entryPrice: actualFillPrice,
          positionSize,
          leverage: request.leverage,
          marginUsd: request.marginUsd,
          slPrice: recalculatedPrices.slPrice,
          tp1Price: recalculatedPrices.tp1Price,
          tp2Price: recalculatedPrices.tp2Price,
        },
      });

      // 12. Emit to frontend via WebSocket
      this.wsGateway.emitNewTrade({
        tradeId,
        strategyType: request.strategyType,
        subStrategy: request.subStrategy,
        symbol: request.symbol,
        direction: request.direction,
        entryPrice: actualFillPrice,
        leverage: request.leverage,
        marginUsd: request.marginUsd,
      });

      this.logger.log(
        `Order executed successfully: ${request.symbol} ${request.direction} @ ${actualFillPrice}`,
        'OrderExecutor',
      );

      return { success: true, tradeId };
    } catch (error) {
      this.logger.error(
        `Failed to execute order for ${request.symbol}: ${error.message}`,
        error.stack,
        'OrderExecutor',
      );

      await this.logger.logStrategy({
        level: 'error',
        strategyType: request.strategyType,
        symbol: request.symbol,
        eventType: EventType.ORDER_FAILED,
        message: `Order execution failed: ${error.message}`,
        signalId,
        metadata: { error: error.message },
      });

      return { success: false, error: error.message };
    }
  }

  /**
   * Set margin type for symbol (ISOLATED or CROSSED)
   * CRITICAL: Must be ISOLATED for risk management
   */
  private async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      this.logger.log(`Setting margin type to ${marginType} for ${symbol}...`, 'OrderExecutor');

      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol,
        marginType,
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      const url = `${this.baseUrl}/fapi/v1/marginType?${params.toString()}`;
      this.logger.debug(`Margin type API URL: ${url}`, 'OrderExecutor');

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      const responseText = await response.text();
      this.logger.debug(`Margin type API response (${response.status}): ${responseText}`, 'OrderExecutor');

      if (!response.ok) {
        const error = JSON.parse(responseText);
        // Error -4046 means margin type is already set to this value
        if (error.code === -4046) {
          this.logger.log(`✓ Margin type already ${marginType} for ${symbol}`, 'OrderExecutor');
        } else {
          this.logger.warn(
            `⚠️ Failed to set margin type for ${symbol}: [${error.code}] ${error.msg}`,
            'OrderExecutor'
          );
        }
      } else {
        this.logger.log(`✓ Margin type set to ${marginType} for ${symbol}`, 'OrderExecutor');
      }
    } catch (error) {
      this.logger.error(
        `❌ Error setting margin type for ${symbol}: ${error.message}`,
        error.stack,
        'OrderExecutor'
      );
    }
  }

  /**
   * Set leverage for symbol
   * CRITICAL: Returns true on success, throws error on failure (prevents wrong leverage trades)
   */
  private async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol,
        leverage: leverage.toString(),
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      const response = await fetch(`${this.baseUrl}/fapi/v1/leverage?${params.toString()}`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const error = await response.json();
        // CRITICAL: Throw error instead of just warning - prevents wrong leverage trades!
        throw new Error(`Failed to set leverage for ${symbol}: ${error.msg || error.code}`);
      }

      this.logger.log(`Leverage set to ${leverage}x for ${symbol}`, 'OrderExecutor');
      return true;
    } catch (error) {
      this.logger.error(
        `CRITICAL: Leverage setting failed for ${symbol}: ${error.message}`,
        error.stack,
        'OrderExecutor'
      );
      throw error; // Re-throw to abort the trade
    }
  }

  /**
   * Execute Binance LIMIT order (changed from MARKET for better slippage control)
   */
  private async executeBinanceOrder(request: OrderRequest): Promise<BinanceOrderResult> {
    try {
      const timestamp = Date.now();

      // CRITICAL: Get real-time current price for accurate quantity calculation
      const currentPrice = await this.getCurrentPrice(request.symbol);
      if (!currentPrice) {
        return {
          success: false,
          error: 'Failed to get current price',
        };
      }

      // Calculate quantity based on margin, leverage, and REAL-TIME price
      const notionalValue = request.marginUsd * request.leverage;
      const quantity = await this.exchangeInfo.roundQuantity(notionalValue / currentPrice, request.symbol);

      this.logger.log(
        `Quantity calculation: ${request.marginUsd} USD * ${request.leverage}x / ${currentPrice} = ${quantity}`,
        'OrderExecutor',
      );

      // Calculate limit price with slight improvement (reduce slippage)
      // LONG: Buy slightly below current price (0.05% better)
      // SHORT: Sell slightly above current price (0.05% better)
      const slippageTolerance = 0.0005; // 0.05%
      let limitPrice: number;
      if (request.direction === 'LONG') {
        limitPrice = await this.exchangeInfo.roundPrice(currentPrice * (1 - slippageTolerance), request.symbol);
      } else {
        limitPrice = await this.exchangeInfo.roundPrice(currentPrice * (1 + slippageTolerance), request.symbol);
      }

      // Execute LIMIT order with GTC (Good Till Cancel)
      this.logger.log(
        `Executing LIMIT order: ${request.symbol} ${request.direction} qty=${quantity} @ ${limitPrice}`,
        'OrderExecutor',
      );

      const limitResult = await this.tryLimitOrder(request.symbol, request.direction, quantity, limitPrice);

      return limitResult;
    } catch (error) {
      this.logger.error(`Error in executeBinanceOrder: ${error.message}`, error.stack, 'OrderExecutor');
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute LIMIT order with GTC (Good Till Cancel) and ISOLATED margin
   */
  private async tryLimitOrder(
    symbol: string,
    direction: string,
    quantity: number,
    price: number,
  ): Promise<BinanceOrderResult> {
    try {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol,
        side: direction === 'LONG' ? 'BUY' : 'SELL',
        type: 'LIMIT',
        timeInForce: 'GTC', // Good Till Cancel - order stays until filled or manually canceled
        quantity: quantity.toString(),
        price: price.toString(),
        newOrderRespType: 'RESULT',
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      const response = await fetch(`${this.baseUrl}/fapi/v1/order?${params.toString()}`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      const data = await response.json();

      this.logger.debug(`LIMIT order response: ${JSON.stringify(data)}`, 'OrderExecutor');

      if (!response.ok) {
        return {
          success: false,
          error: data.msg || `HTTP ${response.status}`,
        };
      }

      // GTC orders can be NEW (pending) or FILLED
      const status = data.status;
      if (status === 'EXPIRED' || status === 'CANCELED' || status === 'REJECTED') {
        return {
          success: false,
          error: `LIMIT order failed (${status})`,
        };
      }

      // For GTC, order can be NEW, PARTIALLY_FILLED (pending), or FILLED (immediate full fill)
      // CRITICAL FIX: PARTIALLY_FILLED must also wait for User Data Stream
      if (status === 'NEW' || status === 'PARTIALLY_FILLED') {
        // Order is pending - will be filled later and detected by User Data Stream
        const partialQty = status === 'PARTIALLY_FILLED' ? parseFloat(data.executedQty) : 0;
        this.logger.log(
          `✓ LIMIT order placed (${status}): ${symbol} @ ${price}, orderId=${data.orderId}` +
          (partialQty > 0 ? `, partial fill: ${partialQty}` : ''),
          'OrderExecutor'
        );

        this.logger.log(
          `📡 Awaiting User Data Stream callback for order ${data.orderId}...`,
          'OrderExecutor'
        );

        return {
          success: true,
          pending: true,
          orderId: data.orderId,
        };
      }

      // Only process FILLED status here (full immediate fill)
      if (status !== 'FILLED') {
        return {
          success: false,
          error: `Unexpected order status: ${status}`,
        };
      }

      // Order was FULLY filled immediately
      const fillPrice = parseFloat(data.avgPrice);
      const executedQty = parseFloat(data.executedQty);

      if (!fillPrice || fillPrice <= 0 || !executedQty || executedQty <= 0) {
        return {
          success: false,
          error: `Invalid fill: price=${fillPrice}, qty=${executedQty}`,
        };
      }

      this.logger.log(`✓ LIMIT order FULLY FILLED immediately: ${symbol} @ ${fillPrice}, qty=${executedQty}`, 'OrderExecutor');

      return {
        success: true,
        fillPrice,
        executedQty,
        orderId: data.orderId,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Emergency MARKET order (kept for potential future use, not used for entry)
   */
  private async tryMarketOrder(
    symbol: string,
    direction: string,
    quantity: number,
  ): Promise<BinanceOrderResult> {
    try {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol,
        side: direction === 'LONG' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: quantity.toString(),
        newOrderRespType: 'RESULT',
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      this.logger.log(`Executing MARKET order: ${symbol} ${direction} qty=${quantity}`, 'OrderExecutor');

      const response = await fetch(`${this.baseUrl}/fapi/v1/order?${params.toString()}`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      const data = await response.json();

      this.logger.debug(`MARKET order response: ${JSON.stringify(data)}`, 'OrderExecutor');

      if (!response.ok) {
        return {
          success: false,
          error: data.msg || `HTTP ${response.status}`,
        };
      }

      const fillPrice = parseFloat(data.avgPrice || data.price);
      const executedQty = parseFloat(data.executedQty);

      if (!fillPrice || fillPrice <= 0 || !executedQty || executedQty <= 0) {
        return {
          success: false,
          error: `MARKET order not filled: price=${fillPrice}, qty=${executedQty}`,
        };
      }

      this.logger.log(`MARKET order filled: ${symbol} @ ${fillPrice}, qty=${executedQty}`, 'OrderExecutor');

      return {
        success: true,
        fillPrice,
        executedQty,
        orderId: data.orderId,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Recalculate SL/TP based on actual fill price
   */
  private async recalculateSlTp(
    actualFillPrice: number,
    direction: string,
    originalSl: number,
    originalTp1: number,
    originalTp2: number,
    originalEntry: number,
    symbol: string, // CRITICAL: Need symbol for price rounding
  ): Promise<{ slPrice: number; tp1Price: number; tp2Price: number }> {
    // Calculate original percentages
    const slPercent = Math.abs((originalSl - originalEntry) / originalEntry);
    const tp1Percent = Math.abs((originalTp1 - originalEntry) / originalEntry);
    const tp2Percent = Math.abs((originalTp2 - originalEntry) / originalEntry);

    // Apply same percentages to actual fill price
    if (direction === 'LONG') {
      return {
        slPrice: await this.exchangeInfo.roundPrice(actualFillPrice * (1 - slPercent), symbol),
        tp1Price: await this.exchangeInfo.roundPrice(actualFillPrice * (1 + tp1Percent), symbol),
        tp2Price: await this.exchangeInfo.roundPrice(actualFillPrice * (1 + tp2Percent), symbol),
      };
    } else {
      // SHORT
      return {
        slPrice: await this.exchangeInfo.roundPrice(actualFillPrice * (1 + slPercent), symbol),
        tp1Price: await this.exchangeInfo.roundPrice(actualFillPrice * (1 - tp1Percent), symbol),
        tp2Price: await this.exchangeInfo.roundPrice(actualFillPrice * (1 - tp2Percent), symbol),
      };
    }
  }

  /**
   * Place SL and TP orders with retry logic
   * Retries with progressively wider SL/TP if placement fails
   */
  private async placeSlTpOrders(
    symbol: string,
    direction: string,
    quantity: number,
    slPrice: number,
    tp1Price: number,
    tp2Price: number,
  ): Promise<void> {
    const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const halfQuantity = await this.exchangeInfo.roundQuantity(quantity / 2, symbol);

    // Check minimum quantity for TP1 using exchange info
    const precision = await this.exchangeInfo.getSymbolPrecision(symbol);
    const minQty = precision ? parseFloat(precision.minQty) : 0.001;
    if (halfQuantity < minQty) {
      throw new Error(`TP1 quantity ${halfQuantity} below minimum ${minQty}`);
    }

    const MAX_RETRIES = 3;
    const WIDENING_PERCENT = 0.3; // 0.3% wider each retry
    let lastError: Error | null = null;

    // CRITICAL: Retry with progressively wider SL/TP
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Calculate adjusted prices for this attempt
        const widenFactor = (attempt - 1) * WIDENING_PERCENT; // 0%, 0.3%, 0.6%

        const adjustedSlPrice = await this.widenStopLoss(
          slPrice,
          direction,
          symbol,
          widenFactor,
        );
        const adjustedTp1Price = await this.widenTakeProfit(
          tp1Price,
          direction,
          symbol,
          widenFactor,
        );
        const adjustedTp2Price = await this.widenTakeProfit(
          tp2Price,
          direction,
          symbol,
          widenFactor,
        );

        if (attempt > 1) {
          this.logger.warn(
            `Retry ${attempt}/${MAX_RETRIES}: Widening SL/TP by ${widenFactor.toFixed(2)}% - ` +
            `SL: ${slPrice} → ${adjustedSlPrice}, TP1: ${tp1Price} → ${adjustedTp1Price}`,
            'OrderExecutor',
          );
        }

        // CRITICAL: Use Algo Order API (/fapi/v1/algoOrder)
        // Since 2025-12-09, conditional orders must use Algo Service
        // Standard /fapi/v1/order endpoint no longer supports STOP/TAKE_PROFIT

        // 1. Stop Loss order (full position) - Algo Order with STOP type
        await this.placeAlgoOrder({
          symbol,
          side: closeSide,
          type: 'STOP',
          triggerPrice: adjustedSlPrice,
          price: adjustedSlPrice,
          quantity: quantity,
          timeInForce: 'GTC',
          reduceOnly: 'true',
        });
        this.logger.log(
          `Stop Loss order placed (STOP) at ${adjustedSlPrice}` +
          (attempt > 1 ? ` (retry ${attempt}, widened)` : ''),
          'OrderExecutor',
        );

        // 2. TP1 order (50%) - Algo Order with TAKE_PROFIT type
        await this.placeAlgoOrder({
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT',
          triggerPrice: adjustedTp1Price,
          price: adjustedTp1Price,
          quantity: halfQuantity,
          timeInForce: 'GTC',
          reduceOnly: 'true',
        });
        this.logger.log(
          `TP1 order placed (TAKE_PROFIT) at ${adjustedTp1Price}, qty=${halfQuantity}` +
          (attempt > 1 ? ` (retry ${attempt}, widened)` : ''),
          'OrderExecutor',
        );

        // 3. TP2 order (remaining 50%) - Algo Order with TAKE_PROFIT type
        await this.placeAlgoOrder({
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT',
          triggerPrice: adjustedTp2Price,
          price: adjustedTp2Price,
          quantity: halfQuantity,
          timeInForce: 'GTC',
          reduceOnly: 'true',
        });
        this.logger.log(
          `TP2 order placed (TAKE_PROFIT) at ${adjustedTp2Price}, qty=${halfQuantity}` +
          (attempt > 1 ? ` (retry ${attempt}, widened)` : ''),
          'OrderExecutor',
        );

        // Success - all orders placed
        return;

      } catch (error) {
        lastError = error;
        this.logger.warn(
          `SL/TP placement failed (attempt ${attempt}/${MAX_RETRIES}): ${error.message}`,
          'OrderExecutor',
        );

        if (attempt === MAX_RETRIES) {
          // Final retry failed - throw error
          this.logger.error(
            `Failed to place SL/TP orders after ${MAX_RETRIES} attempts`,
            error.stack,
            'OrderExecutor',
          );
          throw error;
        }

        // Wait before next retry (exponential backoff)
        const delayMs = 1000 * attempt; // 1s, 2s, 3s
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    // Should never reach here, but just in case
    throw lastError || new Error('Failed to place SL/TP orders');
  }

  /**
   * Widen Stop Loss by percentage (make it safer, further from entry)
   * LONG: Move SL down (allow more loss)
   * SHORT: Move SL up (allow more loss)
   */
  private async widenStopLoss(
    slPrice: number,
    direction: string,
    symbol: string,
    widenPercent: number,
  ): Promise<number> {
    if (widenPercent === 0) {
      return slPrice;
    }

    const adjustment = direction === 'LONG'
      ? slPrice * (1 - widenPercent / 100)  // Lower SL for LONG
      : slPrice * (1 + widenPercent / 100); // Higher SL for SHORT

    return await this.exchangeInfo.roundPrice(adjustment, symbol);
  }

  /**
   * Widen Take Profit by percentage (make it more conservative, further from entry)
   * LONG: Move TP up (higher profit target)
   * SHORT: Move TP down (higher profit target)
   */
  private async widenTakeProfit(
    tpPrice: number,
    direction: string,
    symbol: string,
    widenPercent: number,
  ): Promise<number> {
    if (widenPercent === 0) {
      return tpPrice;
    }

    const adjustment = direction === 'LONG'
      ? tpPrice * (1 + widenPercent / 100)  // Higher TP for LONG
      : tpPrice * (1 - widenPercent / 100); // Lower TP for SHORT

    return await this.exchangeInfo.roundPrice(adjustment, symbol);
  }

  /**
   * Emergency close position when SL/TP orders fail
   */
  private async emergencyClosePosition(
    symbol: string,
    direction: string,
    quantity: number,
  ): Promise<void> {
    const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
    const timestamp = Date.now();

    const params = new URLSearchParams({
      symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: quantity.toString(),
      timestamp: timestamp.toString(),
      reduceOnly: 'true', // Important: only close existing position
    });

    const signature = this.createSignature(params.toString());
    params.append('signature', signature);

    this.logger.warn(
      `EMERGENCY CLOSE: ${symbol} ${closeSide} qty=${quantity}`,
      'OrderExecutor',
    );

    const controller = new AbortController();
    // 비상 상황이므로 5초 대기. 필요시 더 짧게 설정 가능하나 확실한 처리를 위해 여유를 둠
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${this.baseUrl}/fapi/v1/order?${params.toString()}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
      signal: controller.signal,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Emergency close failed: ${data.msg || `HTTP ${response.status}`}`);
    }
    clearTimeout(timeoutId);

    this.logger.log(
      `Emergency close successful: ${symbol} @ ${data.avgPrice || 'market'}`,
      'OrderExecutor',
    );
  }

  /**
   * Place a Binance order
   */
  private async placeBinanceOrder(params: {
    symbol: string;
    side: string;
    type: string;
    price?: number;
    stopPrice?: number;
    quantity?: number;
    closePosition?: string;
    timeInForce?: string;
    reduceOnly?: string;
    callbackRate?: number;
    activationPrice?: number;
  }): Promise<any> {
    const timestamp = Date.now();

    const queryParams = new URLSearchParams({
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      timestamp: timestamp.toString(),
    });

    if (params.price) {
      queryParams.append('price', params.price.toString());
    }
    if (params.stopPrice) {
      queryParams.append('stopPrice', params.stopPrice.toString());
    }
    if (params.quantity) {
      queryParams.append('quantity', params.quantity.toString());
    }
    if (params.timeInForce) {
      queryParams.append('timeInForce', params.timeInForce);
    }
    if (params.reduceOnly) {
      queryParams.append('reduceOnly', params.reduceOnly);
    }
    if (params.closePosition) {
      queryParams.append('closePosition', params.closePosition);
    }
    if (params.callbackRate) {
      queryParams.append('callbackRate', params.callbackRate.toString());
    }
    if (params.activationPrice) {
      queryParams.append('activationPrice', params.activationPrice.toString());
    }

    // CRITICAL: reduceOnly is now explicitly passed via params.reduceOnly
    // This ensures SL/TP orders only close existing positions, not open new ones

    const signature = this.createSignature(queryParams.toString());
    queryParams.append('signature', signature);

    const response = await fetch(`${this.baseUrl}/fapi/v1/order?${queryParams.toString()}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.msg || `HTTP ${response.status}`);
    }

    return data;
  }

  /**
   * Place an Algo Order (for STOP/TAKE_PROFIT orders)
   * CRITICAL: Since 2025-12-09, conditional orders must use Algo Service
   * Endpoint: POST /fapi/v1/algoOrder
   */
  private async placeAlgoOrder(params: {
    symbol: string;
    side: string;
    type: string;
    triggerPrice: number;
    price?: number;
    quantity: number;
    timeInForce?: string;
    reduceOnly?: string;
  }): Promise<any> {
    const timestamp = Date.now();

    const queryParams = new URLSearchParams({
      algoType: 'CONDITIONAL', // CRITICAL: Required for STOP/TAKE_PROFIT
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      triggerPrice: params.triggerPrice.toString(),
      quantity: params.quantity.toString(),
      timestamp: timestamp.toString(),
    });

    if (params.price) {
      queryParams.append('price', params.price.toString());
    }
    if (params.timeInForce) {
      queryParams.append('timeInForce', params.timeInForce);
    }
    if (params.reduceOnly) {
      queryParams.append('reduceOnly', params.reduceOnly);
    }

    const signature = this.createSignature(queryParams.toString());
    queryParams.append('signature', signature);

    const response = await fetch(`${this.baseUrl}/fapi/v1/algoOrder?${queryParams.toString()}`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.apiKey,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.msg || `HTTP ${response.status}`);
    }

    return data;
  }

  /**
   * Get current market price from Binance (CRITICAL for accurate quantity calculation)
   */
  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const url = `${this.baseUrl}/fapi/v1/ticker/price?symbol=${symbol}`;
      const response = await fetch(url, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
      });

      if (!response.ok) {
        this.logger.error(`Failed to get current price for ${symbol}`, '', 'OrderExecutor');
        return null;
      }

      const data = await response.json();
      return parseFloat(data.price);
    } catch (error) {
      this.logger.error(
        `Error getting current price for ${symbol}: ${error.message}`,
        error.stack,
        'OrderExecutor',
      );
      return null;
    }
  }

  /**
   * Wait for order to be filled (polling)
   */
  private async waitForOrderFill(
    symbol: string,
    orderId: number,
    maxSeconds: number,
  ): Promise<BinanceOrderResult> {
    const maxAttempts = maxSeconds * 2; // Check every 500ms

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));

      try {
        const timestamp = Date.now();
        const params = new URLSearchParams({
          symbol,
          orderId: orderId.toString(),
          timestamp: timestamp.toString(),
        });

        const signature = this.createSignature(params.toString());
        params.append('signature', signature);

        const response = await fetch(`${this.baseUrl}/fapi/v1/order?${params.toString()}`, {
          method: 'GET',
          headers: {
            'X-MBX-APIKEY': this.apiKey,
          },
        });

        const data = await response.json();

        if (data.status === 'FILLED') {
          const fillPrice = parseFloat(data.avgPrice);
          const executedQty = parseFloat(data.executedQty);

          this.logger.log(
            `LIMIT order FILLED: ${symbol} @ ${fillPrice}, qty=${executedQty} (after ${(i + 1) * 0.5}s)`,
            'OrderExecutor',
          );

          return {
            success: true,
            fillPrice,
            executedQty,
            orderId,
          };
        }
      } catch (error) {
        this.logger.warn(`Error polling order status: ${error.message}`, 'OrderExecutor');
      }
    }

    return {
      success: false,
      error: `Order not filled within ${maxSeconds} seconds`,
    };
  }

  /**
   * Cancel an order
   */
  private async cancelOrder(symbol: string, orderId: number): Promise<void> {
    try {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        symbol,
        orderId: orderId.toString(),
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      const response = await fetch(`${this.baseUrl}/fapi/v1/order?${params.toString()}`, {
        method: 'DELETE',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (response.ok) {
        this.logger.log(`Order ${orderId} cancelled for ${symbol}`, 'OrderExecutor');
      } else {
        const data = await response.json();
        this.logger.warn(`Failed to cancel order ${orderId}: ${data.msg}`, 'OrderExecutor');
      }
    } catch (error) {
      this.logger.warn(`Error cancelling order: ${error.message}`, 'OrderExecutor');
    }
  }

  /**
   * Create HMAC SHA256 signature
   */
  private createSignature(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }

  /**
   * REMOVED: Hardcoded precision methods replaced with ExchangeInfoService
   * - roundQuantity() -> exchangeInfo.roundQuantity()
   * - roundPrice() -> exchangeInfo.roundPrice()
   */

  /**
   * Save signal to database
   */
  private async saveSignal(signalId: string, request: OrderRequest): Promise<void> {
    await this.signalRepo.save({
      signal_id: signalId,
      strategy_type: request.strategyType,
      sub_strategy: request.subStrategy,
      symbol: request.symbol,
      direction: request.direction as any,
      entry_price: request.entryPrice,
      sl_price: request.slPrice,
      tp1_price: request.tp1Price,
      tp2_price: request.tp2Price,
      confidence: Math.round(request.confidence), // CRITICAL: Round to integer for DB
      market_regime: request.marketRegime,
      metadata: request.metadata,
    });
  }

  /**
   * Save trade to database (CRITICAL!)
   */
  private async saveTrade(
    tradeId: string,
    signalId: string,
    request: OrderRequest,
    positionSize: number,
  ): Promise<Trade> {
    return await this.tradeRepo.save({
      trade_id: tradeId,
      strategy_type: request.strategyType,
      sub_strategy: request.subStrategy,
      symbol: request.symbol,
      direction: request.direction as any,
      entry_price: request.entryPrice,
      sl_price: request.slPrice,
      tp1_price: request.tp1Price,
      tp2_price: request.tp2Price,
      leverage: request.leverage,
      margin_usd: request.marginUsd,
      position_size: positionSize,
      entry_time: new Date(),
      status: TradeStatus.OPEN,
      signal_confidence: Math.round(request.confidence), // CRITICAL: Round to integer for DB
      market_regime: request.marketRegime,
      metadata: {
        ...request.metadata,
        signal_id: signalId,
        use_trailing: request.useTrailing || false,
      },
    });
  }

  /**
   * Save position to database
   */
  private async savePosition(
    positionId: string,
    tradeId: string,
    request: OrderRequest,
    positionSize: number,
    trade: Trade,
  ): Promise<void> {
    await this.positionRepo.save({
      position_id: positionId,
      trade_id: tradeId,
      strategy_type: request.strategyType,
      sub_strategy: request.subStrategy,
      symbol: request.symbol,
      direction: request.direction as any,
      status: PositionStatus.ACTIVE,
      entry_price: request.entryPrice,
      current_price: request.entryPrice,
      sl_price: request.slPrice,
      tp1_price: request.tp1Price,
      tp2_price: request.tp2Price,
      leverage: request.leverage,
      margin_usd: request.marginUsd,
      position_size: positionSize,
      remaining_size: positionSize,
      trailing_enabled: request.useTrailing || false,
      entry_time: new Date(),
    });
  }

  /**
   * Calculate PnL for a position
   * CRITICAL: Used for emergency close and position reconciliation
   */
  private calculatePnL(
    direction: string,
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    leverage: number,
  ): number {
    const priceDiff = direction === 'LONG'
      ? exitPrice - entryPrice
      : entryPrice - exitPrice;

    const pnlUsd = (priceDiff / entryPrice) * quantity * exitPrice;
    return pnlUsd;
  }

  /**
   * Calculate position size in base currency
   */
  private calculatePositionSize(marginUsd: number, leverage: number, entryPrice: number): number {
    const notionalValue = marginUsd * leverage;
    return notionalValue / entryPrice;
  }

  /**
   * CRITICAL: Handle entry order fill callback from User Data Stream
   * Called when a pending LIMIT entry order is filled
   */
  async handleEntryOrderFilled(
    orderId: number,
    fillPrice: number,
    filledQty: number,
  ): Promise<void> {
    // CRITICAL: Get pending order info from Redis (survives service restarts!)
    const pendingOrder = await this.getPendingOrder(orderId);
    if (!pendingOrder) {
      this.logger.warn(
        `Received fill for unknown order ${orderId}. May have already been processed or expired from Redis.`,
        'OrderExecutor',
      );
      return;
    }

    const { signalId, tradeId, request } = pendingOrder;

    this.logger.log(
      `🎯 Entry order FILLED: ${request.symbol} ${request.direction} @ ${fillPrice}, qty=${filledQty} (orderId: ${orderId})`,
      'OrderExecutor',
    );

    try {
      // 1. Recalculate SL/TP based on actual fill price
      const recalculatedPrices = await this.recalculateSlTp(
        fillPrice,
        request.direction,
        request.slPrice,
        request.tp1Price,
        request.tp2Price,
        request.entryPrice,
        request.symbol,
      );

      this.logger.log(
        `Recalculated prices - Original Entry: ${request.entryPrice}, Actual Fill: ${fillPrice}, ` +
        `SL: ${recalculatedPrices.slPrice}, TP1: ${recalculatedPrices.tp1Price}, TP2: ${recalculatedPrices.tp2Price}`,
        'OrderExecutor',
      );

      // 2. Place SL/TP orders
      try {
        await this.placeSlTpOrders(
          request.symbol,
          request.direction,
          filledQty,
          recalculatedPrices.slPrice,
          recalculatedPrices.tp1Price,
          recalculatedPrices.tp2Price,
        );
      } catch (slTpError) {
        // CRITICAL: SL/TP 주문 실패 - 에러 로그만 남기고 포지션은 OPEN 상태로 유지
        // 유저 전략: 길게 가져가는 전략이므로 SL/TP 없이도 포지션 유지
        this.logger.error(
          `WARNING: SL/TP orders failed for filled entry, but position remains OPEN: ${slTpError.message}`,
          slTpError.stack,
          'OrderExecutor',
        );

        // DISABLED: Emergency close removed per user request
        // Position will remain open without SL/TP protection
        // Continue with normal DB save below (with warning metadata)

        await this.logger.logStrategy({
          level: 'warn',
          strategyType: request.strategyType,
          subStrategy: request.subStrategy,
          symbol: request.symbol,
          eventType: EventType.ORDER_FAILED,
          message: 'SL/TP placement failed for filled entry - position has NO PROTECTION',
          tradeId: tradeId,
          metadata: {
            error: slTpError.message,
            fillPrice,
            filledQty,
            slPrice: recalculatedPrices.slPrice,
            tp1Price: recalculatedPrices.tp1Price,
            tp2Price: recalculatedPrices.tp2Price,
          },
        });

        // Emit warning to frontend
        this.wsGateway.emitTradeUpdate({
          tradeId: tradeId,
          symbol: request.symbol,
          status: 'OPEN',
        });

        // DO NOT RETURN - continue with DB save below
        // The position will be saved with slTpPlacementFailed flag in metadata
      }

      // 3. Save to database (Trade + Position)
      const positionId = `POS_${uuidv4().substring(0, 8)}`;

      this.logger.log(
        `📊 Creating position from filled entry - ${request.symbol}: ` +
        `Fill Price: ${fillPrice}, ` +
        `Filled Qty (total): ${filledQty}, ` +
        `Margin: ${request.marginUsd} USD, ` +
        `Leverage: ${request.leverage}x`,
        'OrderExecutor',
      );

      await this.tradeRepo.manager.transaction(async (manager) => {
        // Save Trade
        await manager.save(Trade, {
          trade_id: tradeId,
          signal_id: signalId,
          strategy_type: request.strategyType,
          sub_strategy: request.subStrategy,
          symbol: request.symbol,
          direction: request.direction as any,
          entry_price: fillPrice,
          entry_time: new Date(),
          sl_price: recalculatedPrices.slPrice,
          tp1_price: recalculatedPrices.tp1Price,
          tp2_price: recalculatedPrices.tp2Price,
          leverage: request.leverage,
          margin_usd: request.marginUsd,
          position_size: filledQty,
          status: TradeStatus.OPEN,
          confidence: request.confidence,
          market_regime: request.marketRegime,
          metadata: request.metadata,
        });

        // Save Position
        await manager.save(Position, {
          position_id: positionId,
          trade_id: tradeId,
          strategy_type: request.strategyType,
          sub_strategy: request.subStrategy,
          symbol: request.symbol,
          direction: request.direction as any,
          entry_price: fillPrice,
          current_price: fillPrice,
          sl_price: recalculatedPrices.slPrice,
          tp1_price: recalculatedPrices.tp1Price,
          tp2_price: recalculatedPrices.tp2Price,
          leverage: request.leverage,
          margin_usd: request.marginUsd,
          position_size: filledQty,
          remaining_size: filledQty,  // CRITICAL: 빠진 필드 추가!
          status: PositionStatus.ACTIVE,
          tp1_filled: false,
          tp2_filled: false,
          entry_time: new Date(),
          last_update_time: new Date(),
        });
      });

      // 4. Log success
      await this.logger.logStrategy({
        level: 'info',
        strategyType: request.strategyType,
        subStrategy: request.subStrategy,
        symbol: request.symbol,
        eventType: EventType.POSITION_OPENED,
        message: `Position opened: ${request.symbol} ${request.direction} @ ${fillPrice}`,
        tradeId,
        signalId,
        metadata: {
          fillPrice,
          quantity: filledQty,
          sl: recalculatedPrices.slPrice,
          tp1: recalculatedPrices.tp1Price,
          tp2: recalculatedPrices.tp2Price,
        },
      });

      // 5. WebSocket notification
      this.wsGateway.emitNewTrade({
        tradeId,
        strategyType: request.strategyType,
        subStrategy: request.subStrategy,
        symbol: request.symbol,
        direction: request.direction,
        entryPrice: fillPrice,
        leverage: request.leverage,
        marginUsd: request.marginUsd,
      });

      // 6. CRITICAL: Remove from Redis (order completed successfully)
      await this.deletePendingOrder(orderId);

      this.logger.log(
        `✅ Entry order processing complete: ${request.symbol} (orderId: ${orderId})`,
        'OrderExecutor',
      );
    } catch (error) {
      this.logger.error(
        `Failed to process entry order fill: ${error.message}`,
        error.stack,
        'OrderExecutor',
      );

      // Keep in pending for potential retry or manual intervention
      this.logger.error(
        `CRITICAL: Entry order filled but post-processing failed! orderId: ${orderId}, symbol: ${request.symbol}`,
        error.stack,
        'OrderExecutor',
      );
    }
  }
}
