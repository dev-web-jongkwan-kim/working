import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LotteryOrder } from './entities/lottery-order.entity';
import { LotterySelectionHistory } from './entities/lottery-selection-history.entity';
import { VolumeProviderService } from './volume-provider.service';
import { LotteryFilterService } from './lottery-filter.service';
import { SymbolSelectorService } from './symbol-selector.service';
import { EntryCalculatorService } from './entry-calculator.service';
import { BinanceService } from '../dual-strategy/services/data/binance.service';
import { ExchangeInfoService } from '../dual-strategy/services/data/exchange-info.service';
import { TradingWebSocketGateway } from '../websocket/websocket.gateway';

interface LotteryCandidate {
  symbol: string;
  score: number;
  signals: {
    funding_rate: number;
    funding_level: 'EXTREME' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'N/A';
    change_4h: number;
    momentum: 'EXTREME' | 'VERY_STRONG' | 'STRONG' | 'MEDIUM' | 'WEAK' | 'N/A';
    oi_change: number;
    oi_level: 'SURGE' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'N/A';
    rsi: number;
    rsi_level: 'EXTREME' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'WEAK' | 'N/A';
    volume_ratio?: number;
    volume_spike?: boolean;
    btc_change_1h?: number;
    btc_dropping?: boolean;
    volatility_24h?: number;
    high_volatility?: boolean;
    volume_24h?: number;
    max_leverage?: number;
    change_7d?: number;
    coin_type?: 'MAJOR' | 'TOP10' | 'PUMPING' | 'OTHERS';
  };
  timestamp: number;
}

@Injectable()
export class LotteryExecutorService implements OnModuleInit {
  private readonly logger = new Logger(LotteryExecutorService.name);

  private readonly MAX_POSITIONS = 1; // 로터리 시스템, 1개만 유지
  private readonly POSITION_MARGIN = 20; // USDT (최적화: 15 → 20)
  private readonly STOP_LOSS_PCT = 0.03; // 3% (진입가 대비)
  private isEnabled = false; // 매매 시작 플래그

  // 코인 타입별 레버리지
  private readonly LEVERAGE_BY_TYPE = {
    MAJOR: 20,   // BTC, ETH
    TOP10: 25,   // 메이저 알트
    PUMPING: 30, // 급등 알트
    OTHERS: 35,  // 일반 알트
  };

  constructor(
    @InjectRepository(LotteryOrder)
    private readonly orderRepo: Repository<LotteryOrder>,
    @InjectRepository(LotterySelectionHistory)
    private readonly historyRepo: Repository<LotterySelectionHistory>,
    private readonly volumeProvider: VolumeProviderService,
    private readonly filter: LotteryFilterService,
    private readonly selector: SymbolSelectorService,
    private readonly entryCalculator: EntryCalculatorService,
    private readonly binanceService: BinanceService,
    private readonly exchangeInfo: ExchangeInfoService,
    @Inject(forwardRef(() => TradingWebSocketGateway))
    private readonly wsGateway: TradingWebSocketGateway,
  ) {}

  /**
   * On server start - just log, don't execute
   */
  async onModuleInit() {
    this.logger.log('Lottery service initialized (waiting for start signal)');
  }

  /**
   * Start lottery strategy (called by orchestrator)
   */
  async start() {
    this.logger.log('🎰 Starting Lottery Strategy...');
    this.isEnabled = true;
    await this.execute();
  }

  /**
   * Stop lottery strategy
   */
  async stop() {
    this.logger.log('🛑 Stopping Lottery Strategy...');
    this.isEnabled = false;
  }

  /**
   * Session Full Refresh - 아시아 세션 (09:50 KST)
   * 모든 PENDING 취소 후 새로 3개 생성
   */
  @Cron('50 0 * * *', { timeZone: 'Asia/Seoul' }) // 09:50 KST = 00:50 UTC
  async sessionRefreshAsia() {
    if (!this.isEnabled) return;
    await this.executeSessionRefresh('Asia (09:50 KST)');
  }

  /**
   * Session Full Refresh - 유럽 세션 (17:50 KST)
   */
  @Cron('50 8 * * *', { timeZone: 'Asia/Seoul' }) // 17:50 KST = 08:50 UTC
  async sessionRefreshEurope() {
    if (!this.isEnabled) return;
    await this.executeSessionRefresh('Europe (17:50 KST)');
  }

  /**
   * Session Full Refresh - 미국 세션 (23:20 KST)
   */
  @Cron('20 14 * * *', { timeZone: 'Asia/Seoul' }) // 23:20 KST = 14:20 UTC
  async sessionRefreshUS() {
    if (!this.isEnabled) return;
    await this.executeSessionRefresh('US (23:20 KST)');
  }

  /**
   * Execute session full refresh
   * Cancel all PENDING orders and create new ones
   */
  private async executeSessionRefresh(sessionName: string) {
    this.logger.log(`🎰 [Session Refresh] ${sessionName} - Full refresh starting...`);

    try {
      // 1. Cancel ALL pending orders
      await this.cancelExistingOrders();

      // 2. Get current FILLED count
      const filledCount = await this.orderRepo.count({
        where: { status: 'FILLED' }
      });

      // 3. Calculate how many new orders to place
      const ordersToPlace = this.MAX_POSITIONS - filledCount;
      if (ordersToPlace <= 0) {
        this.logger.log(`[Session Refresh] Already at max with ${filledCount} FILLED positions. No new orders.`);
        return;
      }

      // 4. Get candidates
      const top100 = await this.volumeProvider.getTop100ByVolume();
      const candidates = await this.filter.filterCandidates(top100);

      if (candidates.length === 0) {
        this.logger.warn('[Session Refresh] No candidates found. Market conditions not suitable.');
        return;
      }

      // 5. Select and place orders
      const selected = this.selectRandom(candidates, ordersToPlace);
      this.logger.log(`[Session Refresh] Selected ${selected.length} candidates: ${selected.map(c => c.symbol).join(', ')}`);

      await this.saveSelectionHistory(candidates, selected);

      for (const candidate of selected) {
        await this.placeOrder(candidate);
      }

      this.logger.log(`✅ [Session Refresh] ${sessionName} complete. Placed ${selected.length} new orders.`);

    } catch (error) {
      this.logger.error(`[Session Refresh] Failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Hourly Addition (every 1 hour at 8 minutes past)
   * Only adds orders if PENDING < MAX_POSITIONS
   * 최적화: 정시(0분) 및 15분 배수(15,30,45)를 피해 8분에 실행
   */
  @Cron('8 * * * *')
  async execute() {
    // Check if enabled
    if (!this.isEnabled) {
      return;
    }

    // Count pending orders only (for addition logic)
    const pendingCount = await this.orderRepo.count({
      where: { status: 'PENDING' }
    });

    // Count total active (pending + filled)
    const filledCount = await this.orderRepo.count({
      where: { status: 'FILLED' }
    });

    const totalActive = pendingCount + filledCount;

    this.logger.log(`[Lottery Hourly] PENDING=${pendingCount}, FILLED=${filledCount}, Total=${totalActive}/${this.MAX_POSITIONS}`);

    // Only add if we need more orders
    if (totalActive >= this.MAX_POSITIONS) {
      this.logger.log('[Lottery Hourly] Already at max positions. Skipping.');
      return;
    }

    // Calculate how many orders to add
    const ordersToAdd = this.MAX_POSITIONS - totalActive;
    this.logger.log(`[Lottery Hourly] Adding ${ordersToAdd} new orders...`);

    // Time filter
    if (!this.isOptimalTime()) {
      this.logger.log('Not optimal time. Skipping...');
      return;
    }

    try {
      // 1. Get top 100 by volume
      const top100 = await this.volumeProvider.getTop100ByVolume();
      this.logger.log(`Loaded ${top100.length} symbols by volume`);

      // 2. Filter by conditions
      const candidates = await this.filter.filterCandidates(top100);
      this.logger.log(`Found ${candidates.length} candidates`);

      if (candidates.length === 0) {
        this.logger.warn('No candidates found. Market conditions not suitable.');
        return;
      }

      // 3. Get existing symbols to avoid duplicates
      const existingOrders = await this.orderRepo.find({
        where: [
          { status: 'PENDING' },
          { status: 'FILLED' }
        ]
      });
      const existingSymbols = new Set(existingOrders.map(o => o.symbol));

      // 4. Filter out existing symbols
      const availableCandidates = candidates.filter(c => !existingSymbols.has(c.symbol));
      this.logger.log(`Available candidates (excluding existing): ${availableCandidates.length}`);

      if (availableCandidates.length === 0) {
        this.logger.warn('No new candidates available (all filtered by existing positions).');
        return;
      }

      // 5. 랜덤으로 선택 (필요한 만큼만)
      const selected = this.selectRandom(availableCandidates, ordersToAdd);

      if (selected.length === 0) {
        this.logger.warn('Could not select candidates (랜덤 선택 실패)');
        return;
      }

      this.logger.log(`랜덤 선택 완료: ${selected.map(c => `${c.symbol} (${c.signals.coin_type})`).join(', ')}`);

      // 6. Save selection history
      await this.saveSelectionHistory(candidates, selected);

      // 7. Place new orders (don't cancel existing!)
      for (const candidate of selected) {
        await this.placeOrder(candidate);
      }

      this.logger.log('=== Lottery Addition Complete ===');

    } catch (error) {
      this.logger.error(`Execution failed: ${error.message}`, error.stack);
    }
  }

  /**
   * Check if current time is optimal
   */
  private isOptimalTime(): boolean {
    // Crypto markets are 24/7, always allow execution
    // This method kept for future time-based filtering if needed
    return true;
  }

  /**
   * Cancel existing pending orders
   */
  private async cancelExistingOrders() {
    const existing = await this.orderRepo.find({
      where: { status: 'PENDING' }
    });

    this.logger.log(`Cancelling ${existing.length} existing orders...`);

    for (const order of existing) {
      try {
        await this.binanceService.cancelOrder(order.symbol, order.binance_order_id);

        order.status = 'CANCELLED';
        await this.orderRepo.save(order);

        this.logger.log(`Cancelled: ${order.symbol}`);
      } catch (error) {
        this.logger.warn(`Failed to cancel ${order.symbol}: ${error.message}`);
      }
    }
  }

  /**
   * Place order for candidate
   */
  private async placeOrder(candidate: LotteryCandidate) {
    const { symbol, score, signals } = candidate;

    try {
      // 1. Calculate entry price
      const entryPrice = await this.entryCalculator.calculateEntryPrice(candidate);

      // 2. 코인 타입별 레버리지 설정
      const coinType = signals.coin_type || 'OTHERS';
      const leverage = this.LEVERAGE_BY_TYPE[coinType] || 35;

      try {
        await this.binanceService.setLeverage(symbol, leverage);
      } catch (leverageError) {
        this.logger.error(`❌ [Lottery] Leverage setting failed for ${symbol}. ABORTING order. Error: ${leverageError.message}`);
        return; // 레버리지 설정 실패 시 주문 진행 안 함
      }

      // 3. Calculate quantity with proper rounding
      const notional = this.POSITION_MARGIN * leverage;
      const rawQuantity = notional / entryPrice;
      const quantity = await this.exchangeInfo.roundQuantity(rawQuantity, symbol);

      // 4. Round entry price to symbol precision
      const roundedEntryPrice = await this.exchangeInfo.roundPrice(entryPrice, symbol);

      // 5. Set isolated margin mode
      await this.binanceService.setMarginType(symbol, 'ISOLATED');

      // 6. Place limit order with properly rounded values
      const order = await this.binanceService.futuresOrder({
        symbol,
        side: 'BUY',
        type: 'LIMIT',
        price: roundedEntryPrice.toString(),
        quantity: quantity.toString(),
        timeInForce: 'GTC'
      });

      // 7. Calculate depth
      const ticker = await this.binanceService.getSymbolPriceTicker(symbol);
      const currentPrice = parseFloat(ticker.price);
      const depth = (currentPrice - roundedEntryPrice) / currentPrice * 100;

      // 8. Save to DB
      const lotteryOrder = this.orderRepo.create({
        symbol,
        entry_price: roundedEntryPrice,
        entry_reason: this.formatSignals(signals),
        depth_from_current: depth,
        lottery_score: score,

        order_id: `LOTTERY_${symbol}_${Date.now()}`,
        binance_order_id: order.orderId,
        status: 'PENDING',

        margin: this.POSITION_MARGIN,
        quantity,
        leverage: leverage,
        stop_loss_price: roundedEntryPrice * (1 - this.STOP_LOSS_PCT), // 진입가 대비 -3%

        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h
      });

      await this.orderRepo.save(lotteryOrder);

      this.logger.log(
        `✅ ${symbol} (${coinType}): Entry=${roundedEntryPrice.toFixed(6)} (-${depth.toFixed(1)}%) | ` +
        `Leverage=${leverage}x | Margin=$${this.POSITION_MARGIN} | Qty=${quantity}`
      );

      // Emit WebSocket event
      this.wsGateway.emitNewLotteryOrder({
        orderId: lotteryOrder.order_id,
        symbol: lotteryOrder.symbol,
        entryPrice: lotteryOrder.entry_price,
        lotteryScore: lotteryOrder.lottery_score,
        status: lotteryOrder.status,
        margin: lotteryOrder.margin,
        leverage: lotteryOrder.leverage,
        stopLossPrice: lotteryOrder.stop_loss_price,
      });

    } catch (error) {
      this.logger.error(`Failed to place order for ${symbol}: ${error.message}`);
    }
  }

  /**
   * 랜덤으로 N개 선택
   */
  private selectRandom(candidates: LotteryCandidate[], count: number): LotteryCandidate[] {
    if (candidates.length <= count) {
      return candidates;
    }

    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  /**
   * Format signals for storage
   */
  private formatSignals(signals: any): string {
    return `Type:${signals.coin_type} Fund:${(signals.funding_rate * 100).toFixed(4)}% Vol:$${(signals.volume_24h / 1_000_000).toFixed(0)}M`;
  }

  /**
   * Save selection history
   */
  private async saveSelectionHistory(
    allCandidates: LotteryCandidate[],
    selected: LotteryCandidate[]
  ) {
    await this.historyRepo.save({
      execution_time: new Date(),
      total_candidates: allCandidates.length,
      selected_symbols: selected.map(c => c.symbol),
      selected_scores: selected.map(c => c.score),
      all_candidates: allCandidates
    });
  }

  /**
   * Handle order fill event (called by WebSocket handler)
   */
  async onOrderFilled(binanceOrderId: number, fillPrice: number) {
    const order = await this.orderRepo.findOne({
      where: { binance_order_id: binanceOrderId }
    });

    if (!order) {
      this.logger.warn(`Order not found: ${binanceOrderId}`);
      return;
    }

    this.logger.log(`🎰 LOTTERY HIT! ${order.symbol} filled @ ${fillPrice}`);

    // Update status
    order.status = 'FILLED';
    order.filled_at = new Date();
    await this.orderRepo.save(order);

    // Emit WebSocket event
    this.wsGateway.emitLotteryOrderFilled({
      orderId: order.order_id,
      status: 'FILLED',
      filledAt: order.filled_at,
    });

    // Place stop loss
    await this.placeStopLoss(order);

    // Send notification
    await this.sendNotification({
      title: '🎰 Lottery Hit!',
      message: `${order.symbol} filled at ${fillPrice}\nLeverage: ${order.leverage}x`,
      priority: 'HIGH'
    });

    // Ensure 3 orders exist (refill)
    await this.ensureOrdersExist();
  }

  /**
   * Place stop loss order
   */
  private async placeStopLoss(order: LotteryOrder) {
    try {
      const slOrder = await this.binanceService.futuresOrder({
        symbol: order.symbol,
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: order.stop_loss_price.toFixed(8),
        closePosition: 'true'
      });

      order.stop_loss_order_id = slOrder.orderId;
      await this.orderRepo.save(order);

      this.logger.log(`Stop loss placed for ${order.symbol} @ ${order.stop_loss_price}`);

    } catch (error) {
      this.logger.error(`🚨 [Lottery] SL FAILED for ${order.symbol}: ${error.message}`);
      this.logger.warn(`🚨 [Lottery] EMERGENCY CLOSE: Closing position ${order.symbol} to prevent unprotected loss`);

      // 긴급 청산 - SL 없이 포지션 유지하면 안 됨
      try {
        await this.binanceService.futuresOrder({
          symbol: order.symbol,
          side: 'SELL',
          type: 'MARKET',
          closePosition: 'true',
        });
        this.logger.log(`✅ [Lottery] Emergency close successful for ${order.symbol}`);

        // 상태 업데이트
        order.status = 'CLOSED';
        await this.orderRepo.save(order);
      } catch (closeError) {
        this.logger.error(`🚨🚨 [Lottery] CRITICAL: Emergency close ALSO failed for ${order.symbol}: ${closeError.message}`);
      }
    }
  }

  /**
   * Ensure we always have 2 total positions (pending + filled)
   * 최적화: 로터리 시스템 - 항상 2개 유지
   */
  async ensureOrdersExist() {
    // Count pending + filled positions
    const activePositions = await this.orderRepo.count({
      where: [
        { status: 'PENDING' },
        { status: 'FILLED' }
      ]
    });

    this.logger.log(`[로터리] Active positions (PENDING + FILLED): ${activePositions}/${this.MAX_POSITIONS}`);

    if (activePositions < this.MAX_POSITIONS) {
      this.logger.log(`[로터리] Only ${activePositions} active. Re-executing to maintain ${this.MAX_POSITIONS} positions...`);
      await this.execute();
    } else {
      this.logger.log(`[로터리] Already at max positions (${activePositions}). No refill needed.`);
    }
  }

  /**
   * Send notification (implement with your notification service)
   */
  private async sendNotification(notification: any) {
    this.logger.log(`[NOTIFICATION] ${notification.title}: ${notification.message}`);
    // TODO: Implement Slack/Telegram/Discord notification
  }
}
