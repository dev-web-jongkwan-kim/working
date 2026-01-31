import { Injectable, OnModuleInit, OnModuleDestroy, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as WebSocket from 'ws';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { Position, PositionStatus } from '../../../entities/position.entity';
import { Trade, TradeStatus, CloseReason, StrategyType } from '../../../entities/trade.entity';
import { TradingWebSocketGateway } from '../../../websocket/websocket.gateway';
import { EventType } from '../../../entities/strategy-log.entity';
import { SystemEventType } from '../../../entities/system-log.entity';
import { OrderExecutorService } from '../execution/order-executor.service';
import { RiskManagerService } from '../execution/risk-manager.service';
import { BinanceService } from './binance.service';

/**
 * Binance User Data Stream Event Types
 */
interface OrderTradeUpdateEvent {
  e: 'ORDER_TRADE_UPDATE';
  T: number; // Transaction time
  E: number; // Event time
  o: {
    s: string; // Symbol
    c: string; // Client order ID
    S: 'BUY' | 'SELL'; // Side
    o: string; // Order type
    f: string; // Time in force
    q: string; // Original quantity
    p: string; // Original price
    ap: string; // Average price
    sp: string; // Stop price
    x: string; // Execution type (NEW, CANCELED, CALCULATED, EXPIRED, TRADE)
    X: string; // Order status (NEW, PARTIALLY_FILLED, FILLED, CANCELED, EXPIRED)
    i: number; // Order ID
    l: string; // Last filled quantity
    z: string; // Cumulative filled quantity
    L: string; // Last filled price
    N: string; // Commission asset
    n: string; // Commission amount
    T: number; // Order trade time
    t: number; // Trade ID
    b: string; // Bids notional
    a: string; // Ask notional
    m: boolean; // Is this trade the maker side?
    R: boolean; // Is this reduce only
    wt: string; // Working type (MARK_PRICE, CONTRACT_PRICE)
    ot: string; // Original order type
    ps: 'BOTH' | 'LONG' | 'SHORT'; // Position side
    cp: boolean; // If Close-All, pushed with conditional order
    AP: string; // Activation price, only pushed with TRAILING_STOP_MARKET order
    cr: string; // Callback rate, only pushed with TRAILING_STOP_MARKET order
    rp: string; // Realized profit
  };
}

interface AccountUpdateEvent {
  e: 'ACCOUNT_UPDATE';
  T: number; // Transaction time
  E: number; // Event time
  a: {
    m: string; // Event reason type
    B: Array<{
      a: string; // Asset
      wb: string; // Wallet balance
      cw: string; // Cross wallet balance
    }>;
    P: Array<{
      s: string; // Symbol
      pa: string; // Position amount
      ep: string; // Entry price
      cr: string; // (Pre-fee) Accumulated realized
      up: string; // Unrealized PnL
      mt: string; // Margin type
      iw: string; // Isolated wallet (if isolated position)
      ps: 'BOTH' | 'LONG' | 'SHORT'; // Position side
    }>;
  };
}

/**
 * Binance User Data Stream Service
 *
 * CRITICAL: 이 서비스는 바이낸스의 User Data Stream을 통해
 * 주문 체결, TP/SL 체결, 포지션 변경 등을 실시간으로 받아
 * 자동으로 DB를 업데이트하고 프론트엔드에 알림을 보냅니다.
 *
 * 주요 기능:
 * 1. listenKey 발급 및 60분마다 자동 갱신
 * 2. WebSocket 연결 및 재연결
 * 3. ORDER_TRADE_UPDATE 처리 (TP/SL 체결 감지)
 * 4. ACCOUNT_UPDATE 처리 (포지션 변경 감지)
 * 5. DB 자동 업데이트
 * 6. 프론트엔드 실시간 알림
 */
@Injectable()
export class UserDataStreamService implements OnModuleInit, OnModuleDestroy {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private renewInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private wsUrl: string;

  // CRITICAL: Track partial fill timeouts for handling stale partial fills
  private partialFillTimeouts: Map<number, NodeJS.Timeout> = new Map();
  private readonly PARTIAL_FILL_TIMEOUT_MS = 30000; // 30 seconds
  private readonly MIN_POSITION_VALUE_USD = 10; // Minimum $10 to keep position

  constructor(
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    @InjectRepository(Trade)
    private readonly tradeRepo: Repository<Trade>,
    private readonly logger: CustomLoggerService,
    private readonly wsGateway: TradingWebSocketGateway,
    private readonly configService: ConfigService,
    private readonly binanceService: BinanceService,
    @Inject(forwardRef(() => OrderExecutorService))
    private readonly orderExecutor: OrderExecutorService,
    @Inject(forwardRef(() => RiskManagerService))
    private readonly riskManager: RiskManagerService,
  ) {
    this.apiKey = this.configService.get('BINANCE_API_KEY');
    this.apiSecret = this.configService.get('BINANCE_SECRET_KEY');
    const isTestnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';
    this.baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
    this.wsUrl = isTestnet
      ? 'wss://stream.binancefuture.com/ws'
      : 'wss://fstream.binance.com/ws';
  }

  async onModuleInit() {
    await this.logger.logSystem({
      level: 'info',
      component: 'UserDataStreamService',
      eventType: SystemEventType.SYSTEM_START,
      message: 'Initializing User Data Stream...',
    });

    await this.connect();
  }

  async onModuleDestroy() {
    this.disconnect();
  }

  /**
   * Connect to User Data Stream
   */
  private async connect(): Promise<void> {
    if (this.isConnecting) {
      this.logger.warn('Already connecting to User Data Stream', 'UserDataStream');
      return;
    }

    this.isConnecting = true;

    try {
      // 1. Get listenKey
      this.listenKey = await this.createListenKey();

      if (!this.listenKey) {
        throw new Error('Failed to create listenKey');
      }

      this.logger.log(
        `User Data Stream listenKey created: ${this.listenKey.substring(0, 10)}...`,
        'UserDataStream',
      );

      // 2. Connect WebSocket
      await this.connectWebSocket();

      // 3. Start listenKey renewal (every 30 minutes to be safe, Binance expires in 60 min)
      this.startListenKeyRenewal();

      this.reconnectAttempts = 0;
      this.isConnecting = false;

      await this.logger.logSystem({
        level: 'info',
        component: 'UserDataStreamService',
        eventType: SystemEventType.WEBSOCKET_CONNECT,
        message: 'User Data Stream connected successfully',
        metadata: { listenKey: this.listenKey.substring(0, 10) },
      });

    } catch (error) {
      this.isConnecting = false;
      this.logger.error(
        `Failed to connect User Data Stream: ${error.message}`,
        error.stack,
        'UserDataStream',
      );

      // Retry with exponential backoff
      this.scheduleReconnect();
    }
  }

  /**
   * Create listenKey from Binance API
   */
  private async createListenKey(): Promise<string | null> {
    try {
      const timestamp = Date.now();
      const response = await fetch(`${this.baseUrl}/fapi/v1/listenKey`, {
        method: 'POST',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to create listenKey: ${error}`);
      }

      const data = await response.json();
      return data.listenKey;
    } catch (error) {
      this.logger.error(
        `createListenKey error: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
      return null;
    }
  }

  /**
   * Renew listenKey to keep it alive
   */
  private async renewListenKey(): Promise<boolean> {
    if (!this.listenKey) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/fapi/v1/listenKey`, {
        method: 'PUT',
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to renew listenKey: ${error}`);
      }

      this.logger.log('listenKey renewed successfully', 'UserDataStream');
      return true;
    } catch (error) {
      this.logger.error(
        `renewListenKey error: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
      return false;
    }
  }

  /**
   * Start automatic listenKey renewal every 30 minutes
   */
  private startListenKeyRenewal(): void {
    // Clear existing interval
    if (this.renewInterval) {
      clearInterval(this.renewInterval);
    }

    // Renew every 30 minutes (Binance expires in 60 min)
    this.renewInterval = setInterval(async () => {
      const renewed = await this.renewListenKey();
      if (!renewed) {
        this.logger.error(
          'Failed to renew listenKey. Reconnecting...',
          '',
          'UserDataStream',
        );
        this.disconnect();
        await this.connect();
      }
    }, 30 * 60 * 1000); // 30 minutes
  }

  /**
   * Connect WebSocket
   */
  private async connectWebSocket(): Promise<void> {
    if (!this.listenKey) {
      throw new Error('listenKey is required for WebSocket connection');
    }

    const wsEndpoint = `${this.wsUrl}/${this.listenKey}`;

    this.ws = new WebSocket(wsEndpoint);

    this.ws.on('open', () => {
      this.logger.log('User Data Stream WebSocket connected', 'UserDataStream');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const event = JSON.parse(data.toString());
        this.handleEvent(event);
      } catch (error) {
        this.logger.error(
          `Failed to parse WebSocket message: ${error.message}`,
          error.stack,
          'UserDataStream',
        );
      }
    });

    this.ws.on('error', (error) => {
      this.logger.error(
        `User Data Stream WebSocket error: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
    });

    this.ws.on('close', (code, reason) => {
      this.logger.warn(
        `User Data Stream WebSocket closed: ${code} - ${reason}`,
        'UserDataStream',
      );
      this.scheduleReconnect();
    });

    this.ws.on('ping', () => {
      if (this.ws) {
        this.ws.pong();
      }
    });
  }

  /**
   * Handle incoming events from User Data Stream
   */
  private handleEvent(event: any): void {
    switch (event.e) {
      case 'ORDER_TRADE_UPDATE':
        this.handleOrderTradeUpdate(event as OrderTradeUpdateEvent);
        break;
      case 'ACCOUNT_UPDATE':
        this.handleAccountUpdate(event as AccountUpdateEvent);
        break;
      case 'MARGIN_CALL':
        this.handleMarginCall(event);
        break;
      case 'ACCOUNT_CONFIG_UPDATE':
        this.handleAccountConfigUpdate(event);
        break;
      default:
        this.logger.debug(
          `Unhandled User Data Stream event: ${event.e}`,
          'UserDataStream',
        );
    }
  }

  /**
   * CRITICAL: Handle ORDER_TRADE_UPDATE event
   * This is called when orders (including TP/SL) are filled
   */
  private async handleOrderTradeUpdate(event: OrderTradeUpdateEvent): Promise<void> {
    const { o: order } = event;

    this.logger.log(
      `ORDER_TRADE_UPDATE: ${order.s} ${order.S} ${order.X} - Type: ${order.ot}, ExecType: ${order.x}`,
      'UserDataStream',
    );

    await this.logger.logStrategy({
      level: 'info',
      strategyType: null,
      symbol: order.s,
      eventType: EventType.ORDER_FILLED,
      message: `Order ${order.X}: ${order.s} ${order.S} @ ${order.ap}`,
      metadata: {
        orderId: order.i,
        clientOrderId: order.c,
        side: order.S,
        orderType: order.ot,
        executionType: order.x,
        orderStatus: order.X,
        avgPrice: order.ap,
        filledQty: order.z,
        realizedProfit: order.rp,
      },
    });

    // CRITICAL: Handle partial fills with timeout
    if (order.ot === 'LIMIT' && order.X === 'PARTIALLY_FILLED' && order.x === 'TRADE') {
      const orderId = order.i;
      const filledQty = parseFloat(order.z);
      const fillPrice = parseFloat(order.ap);
      const isReduceOnly = order.R === true;

      this.logger.log(
        `📊 LIMIT order PARTIAL FILL: ${order.s} ${order.S} - Cumulative: ${filledQty}, Last Fill: ${order.l}, OrderId: ${orderId}`,
        'UserDataStream',
      );

      // Only handle entry orders (not reduce-only close orders)
      if (!isReduceOnly) {
        // Start timeout if not already started for this order
        if (!this.partialFillTimeouts.has(orderId)) {
          this.logger.warn(
            `⏱️ Starting ${this.PARTIAL_FILL_TIMEOUT_MS / 1000}s timeout for partial fill: ${order.s} orderId=${orderId}`,
            'UserDataStream',
          );

          const timeout = setTimeout(async () => {
            await this.handlePartialFillTimeout(orderId, order.s, order.S, fillPrice, filledQty);
          }, this.PARTIAL_FILL_TIMEOUT_MS);

          this.partialFillTimeouts.set(orderId, timeout);
        }
      }
    }

    // CRITICAL: Check if this is a LIMIT order being filled
    // Need to distinguish between ENTRY orders and CLOSE orders (from algo order triggers)
    if (order.ot === 'LIMIT' && order.X === 'FILLED') {
      const fillPrice = parseFloat(order.ap);
      const filledQty = parseFloat(order.z); // Cumulative filled quantity
      const isReduceOnly = order.R === true; // Reduce-only flag indicates closing order

      // CRITICAL: Clear partial fill timeout if order is now fully filled
      const orderId = order.i;
      if (this.partialFillTimeouts.has(orderId)) {
        clearTimeout(this.partialFillTimeouts.get(orderId));
        this.partialFillTimeouts.delete(orderId);
        this.logger.log(
          `✅ Partial fill timeout cleared - order fully filled: ${order.s} orderId=${orderId}`,
          'UserDataStream',
        );
      }

      // Check if this LIMIT order is closing an existing position
      // Algo orders (STOP/TAKE_PROFIT) trigger as LIMIT orders with reduceOnly=true
      if (isReduceOnly) {
        this.logger.log(
          `🎯 LIMIT close order FILLED (reduceOnly): ${order.s} ${order.S} @ ${fillPrice}, Qty: ${filledQty}, OrderId: ${order.i}`,
          'UserDataStream',
        );
        // Treat as TP/SL fill - algo order triggered
        await this.handleTpSlFilled(order);
        return;
      }

      // Not reduce-only, so this is an entry order
      this.logger.log(
        `🎯 LIMIT entry order FULLY FILLED: ${order.s} ${order.S} @ ${fillPrice}, Total Qty: ${filledQty}, OrderId: ${order.i}`,
        'UserDataStream',
      );

      // Delegate to OrderExecutorService to complete the order flow
      await this.orderExecutor.handleEntryOrderFilled(order.i, fillPrice, filledQty);
      return;
    }

    // Check if this is a TP/SL order being filled (STOP_MARKET, TAKE_PROFIT_MARKET)
    // FIXED: Only process when FULLY FILLED to avoid duplicate processing of partial fills
    if (
      (order.ot === 'TAKE_PROFIT_MARKET' || order.ot === 'STOP_MARKET' || order.ot === 'TAKE_PROFIT') &&
      order.X === 'FILLED'
    ) {
      await this.handleTpSlFilled(order);
      return;
    }

    // Handle MARKET order that might be closing a position (external close or manual)
    if (order.ot === 'MARKET' && order.X === 'FILLED') {
      await this.handleMarketOrderFilled(order);
    }
  }

  /**
   * CRITICAL: Handle partial fill timeout
   * Called when a LIMIT entry order is partially filled but not fully filled within timeout
   *
   * Logic:
   * 1. Cancel remaining unfilled order
   * 2. Check if filled value >= $10
   * 3. If yes: Set SL/TP based on filled quantity
   * 4. If no: Close position immediately (too small to manage)
   */
  private async handlePartialFillTimeout(
    orderId: number,
    symbol: string,
    side: 'BUY' | 'SELL',
    avgFillPrice: number,
    filledQty: number,
  ): Promise<void> {
    this.logger.warn(
      `⏱️ Partial fill TIMEOUT: ${symbol} orderId=${orderId} - Processing partial fill...`,
      'UserDataStream',
    );

    // Remove from tracking
    this.partialFillTimeouts.delete(orderId);

    try {
      // 1. Get latest order status from Binance to get accurate fill info
      const orderStatus = await this.getOrderStatus(symbol, orderId);

      if (!orderStatus) {
        this.logger.error(
          `Failed to get order status for partial fill: ${symbol} orderId=${orderId}`,
          '',
          'UserDataStream',
        );
        return;
      }

      // Check if order was fully filled while we were waiting
      if (orderStatus.status === 'FILLED') {
        this.logger.log(
          `✅ Order was fully filled before timeout processing: ${symbol} orderId=${orderId}`,
          'UserDataStream',
        );
        // Let the normal FILLED handler deal with it
        return;
      }

      const actualFilledQty = parseFloat(orderStatus.executedQty);
      const actualAvgPrice = parseFloat(orderStatus.avgPrice);
      const originalQty = parseFloat(orderStatus.origQty);

      this.logger.log(
        `📊 Partial fill status: ${symbol} - Filled: ${actualFilledQty}/${originalQty} @ ${actualAvgPrice}`,
        'UserDataStream',
      );

      // 2. Cancel remaining unfilled order
      if (orderStatus.status === 'NEW' || orderStatus.status === 'PARTIALLY_FILLED') {
        await this.cancelOrder(symbol, orderId);
        this.logger.log(
          `🚫 Cancelled unfilled portion: ${symbol} orderId=${orderId}`,
          'UserDataStream',
        );
      }

      // 3. Check if we have any fill at all
      if (actualFilledQty <= 0) {
        this.logger.warn(
          `No fill detected for ${symbol} orderId=${orderId} - nothing to process`,
          'UserDataStream',
        );
        return;
      }

      // 4. Calculate position value
      const positionValueUsd = actualFilledQty * actualAvgPrice;

      this.logger.log(
        `💰 Partial fill value: $${positionValueUsd.toFixed(2)} (min: $${this.MIN_POSITION_VALUE_USD})`,
        'UserDataStream',
      );

      // 5. Delegate to OrderExecutorService to handle partial fill
      // This will set SL/TP if value >= $10, or close immediately if < $10
      await this.orderExecutor.handlePartialFill(
        orderId,
        symbol,
        side === 'BUY' ? 'LONG' : 'SHORT',
        actualAvgPrice,
        actualFilledQty,
        positionValueUsd,
        this.MIN_POSITION_VALUE_USD,
      );

    } catch (error) {
      this.logger.error(
        `Error handling partial fill timeout: ${symbol} orderId=${orderId} - ${error.message}`,
        error.stack,
        'UserDataStream',
      );
    }
  }

  /**
   * 2026-01-24: Move SL to Breakeven after TP1 hit
   * Cancels existing SL order and places new SL at entry price + buffer
   */
  private async moveSlToBreakeven(
    position: Position,
    manager: any,
  ): Promise<void> {
    const symbol = position.symbol;
    const entryPrice = parseFloat(position.entry_price.toString());
    const remainingQty = parseFloat(position.remaining_size.toString());

    // BE buffer: 0.1% above/below entry
    const beBuffer = entryPrice * 0.001;
    const bePrice = position.direction === 'LONG'
      ? entryPrice + beBuffer
      : entryPrice - beBuffer;

    this.logger.log(
      `🎯 Moving SL to BE for ${symbol}: Entry=${entryPrice.toFixed(4)}, ` +
        `BE Price=${bePrice.toFixed(4)}, Direction=${position.direction}`,
      'UserDataStream',
    );

    // 1. Cancel existing SL order
    if (position.sl_order_id) {
      try {
        await this.binanceService.cancelOrder(symbol, parseInt(position.sl_order_id));
        this.logger.log(
          `✅ Cancelled old SL order: ${position.sl_order_id}`,
          'UserDataStream',
        );
      } catch (cancelError) {
        // Order might already be cancelled or filled
        this.logger.warn(
          `⚠️ Failed to cancel old SL order ${position.sl_order_id}: ${cancelError.message}`,
          'UserDataStream',
        );
      }
    }

    // 2. Place new SL at BE price
    try {
      const side = position.direction === 'LONG' ? 'SELL' : 'BUY';
      const newSlOrder = await this.placeStopLossOrder(
        symbol,
        side,
        remainingQty,
        bePrice,
      );

      // 3. Update position with new SL price and order ID
      position.sl_price = bePrice as any;
      if (newSlOrder?.orderId) {
        position.sl_order_id = newSlOrder.orderId.toString();
      }
      await manager.save(Position, position);

      this.logger.log(
        `✅ SL moved to BE for ${symbol}: New SL Price=${bePrice.toFixed(4)}, ` +
          `OrderId=${newSlOrder?.orderId || 'N/A'}`,
        'UserDataStream',
      );
    } catch (placeError) {
      this.logger.error(
        `❌ Failed to place new SL at BE for ${symbol}: ${placeError.message}`,
        placeError.stack,
        'UserDataStream',
      );
      throw placeError;
    }
  }

  /**
   * Place STOP_MARKET order for SL
   */
  private async placeStopLossOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    stopPrice: number,
  ): Promise<any> {
    const timestamp = Date.now();
    const params = new URLSearchParams({
      symbol,
      side,
      type: 'STOP_MARKET',
      stopPrice: stopPrice.toFixed(this.getPricePrecision(stopPrice)),
      quantity: quantity.toString(),
      reduceOnly: 'true',
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

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to place SL order: ${errorData.msg}`);
    }

    return await response.json();
  }

  /**
   * Get price precision based on price value
   */
  private getPricePrecision(price: number): number {
    if (price >= 10000) return 1;
    if (price >= 1000) return 2;
    if (price >= 100) return 3;
    if (price >= 10) return 4;
    if (price >= 1) return 4;
    return 5;
  }

  /**
   * Get order status from Binance
   */
  private async getOrderStatus(symbol: string, orderId: number): Promise<any> {
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

      if (!response.ok) {
        const errorData = await response.json();
        this.logger.error(
          `Failed to get order status: ${errorData.msg}`,
          '',
          'UserDataStream',
        );
        return null;
      }

      return await response.json();
    } catch (error) {
      this.logger.error(
        `Error getting order status: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
      return null;
    }
  }

  /**
   * Cancel an order on Binance
   */
  private async cancelOrder(symbol: string, orderId: number): Promise<boolean> {
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

      if (!response.ok) {
        const errorData = await response.json();
        // Ignore "Unknown order" error - order may have been fully filled or already cancelled
        if (errorData.code === -2011) {
          this.logger.log(`Order already cancelled or filled: ${symbol} orderId=${orderId}`, 'UserDataStream');
          return true;
        }
        this.logger.error(
          `Failed to cancel order: ${errorData.msg}`,
          '',
          'UserDataStream',
        );
        return false;
      }

      return true;
    } catch (error) {
      this.logger.error(
        `Error cancelling order: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
      return false;
    }
  }

  /**
   * CRITICAL: Handle TP/SL order being filled
   * This closes the position and updates DB
   */
  private async handleTpSlFilled(order: any): Promise<void> {
    const symbol = order.s;
    const filledPrice = parseFloat(order.ap);
    const filledQty = parseFloat(order.z);
    const realizedProfit = parseFloat(order.rp);
    const orderType = order.ot;

    this.logger.log(
      `🎯 TP/SL FILLED: ${symbol} ${orderType} @ ${filledPrice}, Qty: ${filledQty}, P&L: $${realizedProfit}`,
      'UserDataStream',
    );

    try {
      // Find active position for this symbol
      const position = await this.positionRepo.findOne({
        where: {
          symbol,
          status: PositionStatus.ACTIVE,
        },
      });

      if (!position) {
        this.logger.warn(
          `No active position found for ${symbol} when TP/SL filled`,
          'UserDataStream',
        );
        return;
      }

      // Define at function level for use in metadata
      const entryPrice = parseFloat(position.entry_price.toString());
      const exitPrice = filledPrice;

      // Determine close reason by matching order ID first, then by price proximity, then by order type
      let closeReason: CloseReason;
      let partialClose = false;
      const orderId = order.i?.toString() || order.c || ''; // Order ID or client order ID

      // Get stored prices for comparison
      const slPrice = parseFloat(position.sl_price?.toString() || '0');
      const tp1Price = parseFloat(position.tp1_price?.toString() || '0');
      const tp2Price = parseFloat(position.tp2_price?.toString() || '0');

      // Price tolerance for matching (0.5% to account for slippage)
      const priceTolerance = 0.005;
      const isNearSl = slPrice > 0 && Math.abs(filledPrice - slPrice) / slPrice < priceTolerance;
      const isNearTp1 = tp1Price > 0 && Math.abs(filledPrice - tp1Price) / tp1Price < priceTolerance;
      const isNearTp2 = tp2Price > 0 && Math.abs(filledPrice - tp2Price) / tp2Price < priceTolerance;

      // CRITICAL: Match order ID to stored SL/TP order IDs for accurate tracking
      if (position.sl_order_id && orderId.includes(position.sl_order_id)) {
        closeReason = CloseReason.STOP_LOSS;
        this.logger.log(`✅ SL order matched by ID: ${orderId}`, 'UserDataStream');
      } else if (position.tp1_order_id && orderId.includes(position.tp1_order_id)) {
        closeReason = CloseReason.TP1;
        partialClose = true;
        position.tp1_filled = true;
        this.logger.log(`✅ TP1 order matched by ID: ${orderId}`, 'UserDataStream');
      } else if (position.tp2_order_id && orderId.includes(position.tp2_order_id)) {
        closeReason = CloseReason.TP2;
        this.logger.log(`✅ TP2 order matched by ID: ${orderId}`, 'UserDataStream');
      } else if (orderType === 'LIMIT' && (isNearSl || isNearTp1 || isNearTp2)) {
        // LIMIT order from algo trigger - match by price proximity
        if (isNearSl) {
          closeReason = CloseReason.STOP_LOSS;
          this.logger.log(`✅ SL matched by price: filled=${filledPrice}, sl=${slPrice}`, 'UserDataStream');
        } else if (isNearTp1 && !position.tp1_filled) {
          closeReason = CloseReason.TP1;
          partialClose = true;
          position.tp1_filled = true;
          this.logger.log(`✅ TP1 matched by price: filled=${filledPrice}, tp1=${tp1Price}`, 'UserDataStream');
        } else if (isNearTp2) {
          closeReason = CloseReason.TP2;
          this.logger.log(`✅ TP2 matched by price: filled=${filledPrice}, tp2=${tp2Price}`, 'UserDataStream');
        } else {
          // TP1 already filled, treat as TP2
          closeReason = CloseReason.TP2;
          this.logger.log(`✅ TP2 matched by price (TP1 filled): filled=${filledPrice}`, 'UserDataStream');
        }
      } else if (orderType === 'TAKE_PROFIT_MARKET' || orderType === 'TAKE_PROFIT') {
        // Fallback: Check by order type if ID matching fails
        if (!position.tp1_filled) {
          closeReason = CloseReason.TP1;
          partialClose = true;
          position.tp1_filled = true;
        } else {
          closeReason = CloseReason.TP2;
        }
        this.logger.log(`⚠️ TP order matched by type (ID not matched): ${orderId}`, 'UserDataStream');
      } else if (orderType === 'STOP_MARKET' || orderType === 'STOP') {
        closeReason = CloseReason.STOP_LOSS;
        this.logger.log(`⚠️ SL order matched by type: ${orderId}`, 'UserDataStream');
      } else {
        // Final fallback for LIMIT orders - determine by price vs entry
        const isLoss = (position.direction === 'LONG' && filledPrice < entryPrice) ||
                       (position.direction === 'SHORT' && filledPrice > entryPrice);
        closeReason = isLoss ? CloseReason.STOP_LOSS : CloseReason.TP1;
        if (!isLoss && !position.tp1_filled) {
          partialClose = true;
          position.tp1_filled = true;
        }
        this.logger.log(`⚠️ Close reason determined by P&L direction: ${closeReason} (price=${filledPrice}, entry=${entryPrice})`, 'UserDataStream');
      }

      // CRITICAL: Use Binance's realized profit directly (already includes fees and leverage)
      // order.rp contains the actual realized PNL from Binance - this is the source of truth
      const binancePnl = realizedProfit;
      const marginUsd = parseFloat(position.margin_usd.toString());

      // Only calculate as fallback if Binance doesn't provide profit
      let pnlUsd: number;
      if (!isNaN(binancePnl) && binancePnl !== 0) {
        pnlUsd = binancePnl;
        this.logger.log(
          `💰 Using Binance realizedProfit: $${binancePnl.toFixed(4)}`,
          'UserDataStream',
        );
      } else {
        // Fallback: Calculate manually (without leverage - Binance profit doesn't need it)
        const direction = position.direction;
        const priceDiff = direction === 'LONG'
          ? exitPrice - entryPrice
          : entryPrice - exitPrice;
        pnlUsd = priceDiff * filledQty;
        this.logger.warn(
          `⚠️ Binance realizedProfit unavailable, calculated: $${pnlUsd.toFixed(4)}`,
          'UserDataStream',
        );
      }

      const pnlPercent = (pnlUsd / marginUsd) * 100;

      this.logger.log(
        `Position P&L: $${pnlUsd.toFixed(2)} (${pnlPercent.toFixed(2)}%)`,
        'UserDataStream',
      );

      // Update in transaction
      await this.positionRepo.manager.transaction(async (manager) => {
        if (partialClose) {
          // Partial close (TP1)
          this.logger.log(
            `📊 TP1 Partial Close - ${symbol}: ` +
            `Position Size: ${position.position_size}, ` +
            `Current Remaining: ${position.remaining_size}, ` +
            `Filled Qty: ${filledQty}, ` +
            `Binance PnL: $${pnlUsd.toFixed(2)}`,
            'UserDataStream',
          );

          const remainingQty = parseFloat(position.remaining_size.toString()) - filledQty;
          const newRealizedPnl = parseFloat(position.realized_pnl.toString()) + pnlUsd;

          position.remaining_size = remainingQty.toString() as any;
          position.realized_pnl = newRealizedPnl.toString() as any;
          position.last_update_time = new Date();

          await manager.save(Position, position);

          this.logger.log(
            `💰 TP1 Updated - ${symbol}: Remaining: ${remainingQty.toFixed(4)}, Realized PnL: $${newRealizedPnl.toFixed(2)} (${(newRealizedPnl / marginUsd * 100).toFixed(2)}%)`,
            'UserDataStream',
          );

          // Emit WebSocket event
          this.wsGateway.emitPositionUpdate({
            positionId: position.position_id,
            symbol: position.symbol,
            remainingSize: remainingQty,
            realizedPnl: newRealizedPnl,
            tp1Filled: true,
          });

          // 2026-01-24: TP1 달성 시 SL을 BE(Breakeven)로 이동
          try {
            await this.moveSlToBreakeven(position, manager);
          } catch (beError) {
            this.logger.error(
              `Failed to move SL to BE for ${symbol}: ${beError.message}`,
              beError.stack,
              'UserDataStream',
            );
          }

        } else {
          // Full close
          this.logger.log(
            `📊 Full Close (${closeReason}) - ${symbol}: ` +
            `Position Size: ${position.position_size}, ` +
            `Remaining: ${position.remaining_size}, ` +
            `Filled Qty: ${filledQty}, ` +
            `Exit Price: ${filledPrice}`,
            'UserDataStream',
          );

          // Add this close's PnL to any previously realized PnL (from partial closes)
          const previousRealizedPnl = parseFloat(position.realized_pnl.toString()) || 0;
          const finalPnl = previousRealizedPnl + pnlUsd;
          const finalPnlPercent = (finalPnl / marginUsd) * 100;

          this.logger.log(
            `💰 Final P&L: $${finalPnl.toFixed(2)} (prev: $${previousRealizedPnl.toFixed(2)} + this: $${pnlUsd.toFixed(2)})`,
            'UserDataStream',
          );

          position.status = PositionStatus.CLOSED;
          position.remaining_size = '0' as any;
          position.realized_pnl = finalPnl.toString() as any;
          position.last_update_time = new Date();

          await manager.save(Position, position);

          // Update trade
          await manager.update(
            Trade,
            { trade_id: position.trade_id },
            {
              status: TradeStatus.CLOSED,
              exit_price: filledPrice.toString() as any,
              exit_time: new Date(),
              close_reason: closeReason,
              pnl_usd: finalPnl.toString() as any,
              pnl_percent: finalPnlPercent.toString() as any,
            },
          );

          this.logger.log(
            `✅ Position CLOSED: ${symbol} @ ${filledPrice}, P&L: $${finalPnl.toFixed(2)} (${finalPnlPercent.toFixed(2)}%) [${closeReason}]`,
            'UserDataStream',
          );

          await this.logger.logStrategy({
            level: 'info',
            strategyType: position.strategy_type,
            subStrategy: position.sub_strategy,
            symbol: position.symbol,
            eventType: EventType.POSITION_CLOSED,
            message: `Position closed: ${closeReason}`,
            positionId: position.position_id,
            tradeId: position.trade_id,
            metadata: {
              entryPrice,
              exitPrice,
              pnlUsd,
              pnlPercent,
              closeReason,
            },
          });

          // Emit WebSocket events
          this.wsGateway.emitPositionClosed({
            positionId: position.position_id,
            symbol: position.symbol,
            closeReason,
            exitPrice,
            pnl: pnlUsd,
            pnlPercent,
          });

          this.wsGateway.emitTradeClosed({
            tradeId: position.trade_id,
            symbol: position.symbol,
            status: 'CLOSED',
            closeReason,
            exitPrice,
            pnl: pnlUsd,
            pnlPercent,
          });
        }
      });

      // CRITICAL: Record trade outcome for risk management (symbol cooldown, consecutive losses)
      // Only for full position close (not partial TP1)
      if (!partialClose) {
        try {
          const finalPnl = parseFloat(position.realized_pnl.toString());
          await this.riskManager.recordTradeOutcome(finalPnl, symbol);
          this.logger.log(
            `📊 Trade outcome recorded: ${symbol} P&L: $${finalPnl.toFixed(2)}`,
            'UserDataStream',
          );

          // Legacy Hour Swing kill switch removed - strategy deprecated
        } catch (riskError) {
          this.logger.error(
            `Failed to record trade outcome for ${symbol}: ${riskError.message}`,
            riskError.stack,
            'UserDataStream',
          );
        }

        // CRITICAL: Cancel all remaining conditional orders (TP/SL) after position is fully closed
        try {
          await this.binanceService.cancelAllOrders(symbol);
          this.logger.log(
            `🗑️ All conditional orders cancelled for ${symbol}`,
            'UserDataStream',
          );
        } catch (cancelError) {
          this.logger.warn(
            `Failed to cancel orders for ${symbol}: ${cancelError.message}`,
            'UserDataStream',
          );
        }
      }

    } catch (error) {
      this.logger.error(
        `Failed to handle TP/SL fill for ${symbol}: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
    }
  }

  /**
   * CRITICAL: Handle MARKET order being filled (external close or manual)
   * This handles positions closed outside our system (mobile app, web, other bots)
   */
  private async handleMarketOrderFilled(order: any): Promise<void> {
    const symbol = order.s;
    const filledPrice = parseFloat(order.ap);
    const filledQty = parseFloat(order.z);
    const orderSide = order.S; // BUY or SELL
    const realizedProfit = parseFloat(order.rp);

    this.logger.log(
      `Market order filled: ${symbol} ${orderSide} @ ${filledPrice}, Qty: ${filledQty}, P&L: $${realizedProfit}`,
      'UserDataStream',
    );

    try {
      // Find active position for this symbol
      const position = await this.positionRepo.findOne({
        where: {
          symbol,
          status: PositionStatus.ACTIVE,
        },
      });

      if (!position) {
        this.logger.debug(
          `No active position found for ${symbol} MARKET order (might be entry order)`,
          'UserDataStream',
        );
        return;
      }

      // Check if this MARKET order is closing the position
      const isClosing =
        (position.direction === 'LONG' && orderSide === 'SELL') ||
        (position.direction === 'SHORT' && orderSide === 'BUY');

      if (!isClosing) {
        this.logger.debug(
          `MARKET order ${orderSide} does not close ${position.direction} position for ${symbol}`,
          'UserDataStream',
        );
        return;
      }

      // Position is being closed by external MARKET order
      this.logger.warn(
        `⚠️ EXTERNAL CLOSE DETECTED: ${symbol} ${position.direction} position closed by MARKET ${orderSide} order @ ${filledPrice}`,
        'UserDataStream',
      );

      // Calculate P&L
      const calculatedPnl = this.calculatePnL(
        position.direction,
        position.entry_price,
        filledPrice,
        filledQty,
        position.leverage,
      );

      // CRITICAL: Use Binance's realized profit for accuracy
      const binancePnl = realizedProfit;
      const pnlUsd = isNaN(binancePnl) || binancePnl === 0 ? calculatedPnl : binancePnl;

      if (!isNaN(binancePnl) && binancePnl !== 0) {
        this.logger.log(
          `💰 Using Binance realizedProfit: $${binancePnl.toFixed(2)} (Calculated: $${calculatedPnl.toFixed(2)})`,
          'UserDataStream',
        );
      }

      const partialClose = filledQty < position.remaining_size;

      // Update position to CLOSED
      await this.positionRepo.update(position.id, {
        status: PositionStatus.CLOSED,
        current_price: filledPrice,
        realized_pnl: Number(position.realized_pnl) + pnlUsd,
        remaining_size: 0,
      });

      // Update trade to CLOSED
      const trade = await this.tradeRepo.findOne({
        where: { trade_id: position.trade_id },
      });

      if (trade) {
        const finalPnl = Number(position.realized_pnl) + pnlUsd;
        const finalPnlPercent = (finalPnl / Number(trade.margin_usd)) * 100;

        await this.tradeRepo.update(trade.id, {
          status: TradeStatus.CLOSED,
          exit_price: filledPrice,
          exit_time: new Date(),
          pnl_usd: finalPnl,
          pnl_percent: finalPnlPercent,
          close_reason: CloseReason.MANUAL, // External close
        });

        // Record trade outcome for risk management (symbol cooldown)
        if (!partialClose) {
          try {
            await this.riskManager.recordTradeOutcome(finalPnl, symbol);
            this.logger.log(
              `📊 Trade outcome recorded: ${symbol} P&L: ${finalPnl.toFixed(2)} (EXTERNAL CLOSE)`,
              'UserDataStream',
            );

            // Legacy Hour Swing kill switch removed - strategy deprecated
          } catch (riskError) {
            this.logger.error(
              `Failed to record trade outcome for ${symbol}: ${riskError.message}`,
              riskError.stack,
              'UserDataStream',
            );
          }

          // CRITICAL: Cancel all remaining conditional orders after external close
          try {
            await this.binanceService.cancelAllOrders(symbol);
            this.logger.log(
              `🗑️ All conditional orders cancelled for ${symbol} (EXTERNAL CLOSE)`,
              'UserDataStream',
            );
          } catch (cancelError) {
            this.logger.warn(
              `Failed to cancel orders for ${symbol}: ${cancelError.message}`,
              'UserDataStream',
            );
          }
        }

        this.logger.warn(
          `🔴 Position CLOSED (EXTERNAL): ${symbol} ${position.direction} @ ${filledPrice} | ` +
            `P&L: $${finalPnl.toFixed(2)} (${finalPnlPercent.toFixed(2)}%)`,
          'UserDataStream',
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to handle MARKET order fill for ${symbol}: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
    }
  }

  /**
   * Calculate P&L
   */
  private calculatePnL(
    direction: string,
    entryPrice: number,
    exitPrice: number,
    quantity: number,
    leverage: number,
  ): number {
    const priceDiff = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
    const pnl = (priceDiff / entryPrice) * quantity * entryPrice;
    return pnl;
  }

  /**
   * Handle ACCOUNT_UPDATE event
   * CRITICAL: Backup mechanism with timing check to prevent race conditions
   */
  private async handleAccountUpdate(event: AccountUpdateEvent): Promise<void> {
    this.logger.debug(
      `ACCOUNT_UPDATE: Reason=${event.a.m}, Positions=${event.a.P.length}`,
      'UserDataStream',
    );

    // Update positions based on Binance data
    for (const positionData of event.a.P) {
      const symbol = positionData.s;
      const positionAmt = parseFloat(positionData.pa);
      const entryPrice = parseFloat(positionData.ep);
      const unrealizedPnl = parseFloat(positionData.up);

      // Check if position is closed (backup mechanism with timing check)
      if (positionAmt === 0) {
        await this.handlePositionClosedFromBinance(symbol);
      }
    }
  }

  /**
   * Handle position closed from Binance side
   * CRITICAL: Backup mechanism for missed ORDER_TRADE_UPDATE events
   * Uses timing check to prevent race condition with ORDER_TRADE_UPDATE
   */
  private async handlePositionClosedFromBinance(symbol: string): Promise<void> {
    const position = await this.positionRepo.findOne({
      where: {
        symbol,
        status: PositionStatus.ACTIVE,
      },
    });

    if (!position) {
      // No active position found - already closed or never existed
      return;
    }

    // CRITICAL: Race condition prevention
    // ORDER_TRADE_UPDATE and ACCOUNT_UPDATE arrive nearly simultaneously
    // If position was updated recently, ORDER_TRADE_UPDATE is likely processing it
    const timeSinceLastUpdate = Date.now() - position.last_update_time.getTime();
    const GRACE_PERIOD_MS = 5000; // 5 seconds

    if (timeSinceLastUpdate < GRACE_PERIOD_MS) {
      this.logger.debug(
        `Position ${symbol} updated ${Math.floor(timeSinceLastUpdate / 1000)}s ago, ` +
        `skipping auto-sync (ORDER_TRADE_UPDATE likely in progress)`,
        'UserDataStream',
      );
      return;
    }

    // Position closed on Binance but still ACTIVE in DB for >5 seconds
    // This is a genuine missed closure (manual close, network issue, etc.)
    this.logger.warn(
      `Position ${symbol} closed on Binance but still ACTIVE in DB ` +
      `(last update: ${Math.floor(timeSinceLastUpdate / 1000)}s ago). Syncing...`,
      'UserDataStream',
    );

    // Get current market price for PnL calculation
    const currentPrice = parseFloat(position.current_price.toString());
    const entryPrice = parseFloat(position.entry_price.toString());
    const quantity = parseFloat(position.remaining_size.toString());

    const pnl = this.calculatePnL(
      position.direction,
      entryPrice,
      currentPrice,
      quantity,
      position.leverage,
    );

    // Sync to DB
    await this.positionRepo.manager.transaction(async (manager) => {
      position.status = PositionStatus.CLOSED;
      position.remaining_size = '0' as any;
      position.last_update_time = new Date();
      await manager.save(Position, position);

      await manager.update(
        Trade,
        { trade_id: position.trade_id },
        {
          status: TradeStatus.CLOSED,
          exit_price: currentPrice.toString() as any,
          exit_time: new Date(),
          close_reason: CloseReason.MANUAL,
          pnl_usd: pnl.toString() as any,
          pnl_percent: ((pnl / parseFloat(position.margin_usd.toString())) * 100).toString() as any,
        },
      );
    });

    this.logger.log(
      `✅ Position synced: ${symbol} closed @ ${currentPrice}, P&L: $${pnl.toFixed(2)} (MANUAL)`,
      'UserDataStream',
    );

    // Record trade outcome for risk management
    try {
      await this.riskManager.recordTradeOutcome(pnl, symbol);

      // Legacy Hour Swing kill switch removed - strategy deprecated
    } catch (error) {
      this.logger.error(
        `Failed to record trade outcome for ${symbol}: ${error.message}`,
        error.stack,
        'UserDataStream',
      );
    }

    // CRITICAL: Cancel all remaining conditional orders after position sync
    try {
      await this.binanceService.cancelAllOrders(symbol);
      this.logger.log(
        `🗑️ All conditional orders cancelled for ${symbol} (SYNC)`,
        'UserDataStream',
      );
    } catch (cancelError) {
      this.logger.warn(
        `Failed to cancel orders for ${symbol}: ${cancelError.message}`,
        'UserDataStream',
      );
    }
  }

  /**
   * Handle MARGIN_CALL event
   */
  private async handleMarginCall(event: any): Promise<void> {
    this.logger.error(
      `⚠️ MARGIN CALL RECEIVED! Check positions immediately!`,
      JSON.stringify(event),
      'UserDataStream',
    );

    await this.logger.logSystem({
      level: 'error',
      component: 'UserDataStreamService',
      eventType: SystemEventType.WEBSOCKET_ERROR,
      message: 'MARGIN CALL received from Binance',
      metadata: event,
    });

    // Emit to frontend
    this.wsGateway.emitMarginCall(event);
  }

  /**
   * Handle ACCOUNT_CONFIG_UPDATE event
   */
  private handleAccountConfigUpdate(event: any): void {
    this.logger.log(
      `Account config updated: ${JSON.stringify(event)}`,
      'UserDataStream',
    );
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error(
        `Max reconnect attempts (${this.maxReconnectAttempts}) reached. Stopping reconnection.`,
        '',
        'UserDataStream',
      );
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Max 30 seconds
    this.reconnectAttempts++;

    this.logger.log(
      `Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
      'UserDataStream',
    );

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      await this.connect();
    }, delay);
  }

  /**
   * Disconnect from User Data Stream
   */
  private disconnect(): void {
    this.logger.log('Disconnecting User Data Stream...', 'UserDataStream');

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    if (this.renewInterval) {
      clearInterval(this.renewInterval);
      this.renewInterval = null;
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    this.listenKey = null;
    this.isConnecting = false;
  }

  /**
   * Manual reconnect (for testing or recovery)
   */
  async reconnect(): Promise<void> {
    this.disconnect();
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Create HMAC SHA256 signature for Binance API
   */
  private createSignature(queryString: string): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(queryString)
      .digest('hex');
  }
}
