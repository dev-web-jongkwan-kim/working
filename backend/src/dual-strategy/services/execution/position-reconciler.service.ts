import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { Position, PositionStatus } from '../../../entities/position.entity';
import { Trade, TradeStatus } from '../../../entities/trade.entity';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { TradingWebSocketGateway } from '../../../websocket/websocket.gateway';
import { EventType } from '../../../entities/strategy-log.entity';
import { RiskManagerService } from './risk-manager.service';

interface BinancePosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  notional: string;
  updateTime: number;
}

/**
 * Position Reconciler Service
 * Syncs local DB positions with actual Binance account positions
 * Prevents drift between bot state and exchange state
 */
@Injectable()
export class PositionReconcilerService {
  private readonly logger = new Logger(PositionReconcilerService.name);
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;

  constructor(
    @InjectRepository(Position)
    private readonly positionRepo: Repository<Position>,
    private readonly loggerService: CustomLoggerService,
    private readonly wsGateway: TradingWebSocketGateway,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => RiskManagerService))
    private readonly riskManager: RiskManagerService,
  ) {
    this.apiKey = this.configService.get('BINANCE_API_KEY');
    this.apiSecret = this.configService.get('BINANCE_SECRET_KEY');
    const isTestnet = this.configService.get('BINANCE_TESTNET', 'false') === 'true';
    this.baseUrl = isTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  /**
   * Run reconciliation every 1 minute
   * DISABLED: User Data Stream handles all position updates in real-time
   * Reconciler can interfere with pending orders and normal closures
   */
  // @Cron(CronExpression.EVERY_MINUTE)
  async runReconciliation() {
    // DISABLED - User Data Stream is more reliable
    // Only enable for manual debugging via API call
    return;
  }

  /**
   * Main reconciliation logic
   * DISABLED: User Data Stream handles all position updates in real-time
   */
  async reconcilePositions(): Promise<void> {
    // CRITICAL: COMPLETELY DISABLED
    // User Data Stream is more accurate and real-time
    // Reconciler can cause false positives and unwanted closures
    this.logger.debug('Reconciler disabled - User Data Stream handles all updates');
    return;

    try {
      // 1. Get all active positions from Binance
      const binancePositions = await this.getBinancePositions();

      // 2. Get all active positions from DB
      const dbPositions = await this.positionRepo.find({
        where: { status: PositionStatus.ACTIVE },
      });

      this.logger.debug(
        `Reconciliation: ${binancePositions.length} Binance positions, ${dbPositions.length} DB positions`,
      );

      // 3. Check DB positions that don't exist on Binance (forcibly closed or liquidated)
      for (const dbPos of dbPositions) {
        const binancePos = binancePositions.find(bp => bp.symbol === dbPos.symbol);

        if (!binancePos || parseFloat(binancePos.positionAmt) === 0) {
          // Position closed on exchange but still open in DB
          this.logger.warn(
            `Position ${dbPos.symbol} closed on exchange but still open in DB. Marking as closed.`,
          );

          await this.closePositionInDb(dbPos, 'FORCED_CLOSE_OR_LIQUIDATION');

          await this.loggerService.logStrategy({
            level: 'warn',
            strategyType: dbPos.strategy_type,
            subStrategy: dbPos.sub_strategy,
            symbol: dbPos.symbol,
            eventType: EventType.POSITION_UPDATED,
            message: 'Position closed on exchange, synced to DB',
            metadata: {
              positionId: dbPos.position_id,
              reason: 'forced_close_or_liquidation',
            },
          });
        } else {
          // Position exists but check for discrepancies
          const binanceQty = Math.abs(parseFloat(binancePos.positionAmt));
          const dbQty = dbPos.position_size;

          if (Math.abs(binanceQty - dbQty) > dbQty * 0.01) {
            // More than 1% difference
            this.logger.warn(
              `Position size mismatch for ${dbPos.symbol}: DB=${dbQty}, Binance=${binanceQty}`,
            );

            await this.loggerService.logStrategy({
              level: 'warn',
              strategyType: dbPos.strategy_type,
              subStrategy: dbPos.sub_strategy,
              symbol: dbPos.symbol,
              eventType: EventType.POSITION_UPDATED,
              message: 'Position size mismatch detected',
              metadata: {
                dbQuantity: dbQty,
                binanceQuantity: binanceQty,
                difference: Math.abs(binanceQty - dbQty),
              },
            });
          }
        }
      }

      // 4. Check Binance positions that don't exist in DB (manually opened?)
      for (const binancePos of binancePositions) {
        const positionAmt = parseFloat(binancePos.positionAmt);
        if (positionAmt === 0) continue; // Skip empty positions

        const dbPos = dbPositions.find(dp => dp.symbol === binancePos.symbol);

        if (!dbPos) {
          this.logger.warn(
            `Position ${binancePos.symbol} exists on Binance but not in DB. Possibly manually opened.`,
          );

          await this.loggerService.logStrategy({
            level: 'warn',
            strategyType: 'MANUAL' as any,
            subStrategy: 'unknown',
            symbol: binancePos.symbol,
            eventType: EventType.POSITION_UPDATED,
            message: 'Unexpected position found on exchange',
            metadata: {
              positionAmt: binancePos.positionAmt,
              entryPrice: binancePos.entryPrice,
              unrealizedProfit: binancePos.unRealizedProfit,
            },
          });
        }
      }

      this.logger.debug('Reconciliation completed');
    } catch (error) {
      this.logger.error(`Error in reconcilePositions: ${error.message}`, error.stack);
    }
  }

  /**
   * Get all positions from Binance
   */
  private async getBinancePositions(): Promise<BinancePosition[]> {
    try {
      const timestamp = Date.now();
      const params = new URLSearchParams({
        timestamp: timestamp.toString(),
      });

      const signature = this.createSignature(params.toString());
      params.append('signature', signature);

      const response = await fetch(`${this.baseUrl}/fapi/v2/positionRisk?${params.toString()}`, {
        headers: {
          'X-MBX-APIKEY': this.apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get positions from Binance: ${response.statusText} - ${errorText}`);
      }

      const positions: BinancePosition[] = await response.json();

      // Filter only positions with non-zero amount
      return positions.filter(p => parseFloat(p.positionAmt) !== 0);
    } catch (error) {
      this.logger.error(`Error fetching Binance positions: ${error.message}`, error.stack);
      return [];
    }
  }

  /**
   * Close position in DB with final price and PnL
   * CRITICAL: Updates Trade and Position with actual exit data
   */
  private async closePositionInDb(position: Position, reason: string): Promise<void> {
    try {
      // Get current market price from Binance (or use position's current_price as fallback)
      const binancePositions = await this.getBinancePositions();
      const binancePos = binancePositions.find(bp => bp.symbol === position.symbol);
      const exitPrice = binancePos ? parseFloat(binancePos.markPrice) : Number(position.current_price);

      // Calculate PnL
      const pnl = this.calculatePnL(
        position.direction,
        Number(position.entry_price),
        exitPrice,
        Number(position.remaining_size),
        position.leverage,
      );

      // CRITICAL: Update both Position and Trade in transaction
      await this.positionRepo.manager.transaction(async (manager) => {
        // Update Position
        await manager.update(Position, { position_id: position.position_id }, {
          status: PositionStatus.CLOSED,
          current_price: exitPrice,
          unrealized_pnl: 0,
        });

        // Update Trade
        const trade = await manager.findOne(Trade, {
          where: { trade_id: position.trade_id },
        });

        if (trade) {
          await manager.update(Trade, { id: trade.id }, {
            status: TradeStatus.CLOSED,
            exit_price: exitPrice,
            exit_time: new Date(),
            pnl_usd: pnl,
            pnl_percent: (pnl / Number(trade.margin_usd)) * 100,
            close_reason: reason as any,
          });

          // Record trade outcome for risk management
          // Note: recordTradeOutcome is now async
          // We don't await it here to avoid blocking, but log any errors
          this.riskManager.recordTradeOutcome(pnl, position.symbol).catch(err => {
            this.logger.error(`Failed to record trade outcome: ${err.message}`, err.stack);
          });
        }
      });

      this.logger.log(
        `Position ${position.position_id} closed: ${reason}, Exit: ${exitPrice}, PnL: ${pnl.toFixed(2)} USD`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to close position in DB: ${position.position_id}`,
        error.stack,
      );
    }
  }

  /**
   * Calculate PnL for a position (수수료 포함)
   * 바이낸스 선물 수수료: 테이커 0.04% (진입 + 청산 = 0.08%)
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

    const notional = quantity * exitPrice;
    const pnlUsd = (priceDiff / entryPrice) * notional;

    // 수수료 차감 (진입 0.04% + 청산 0.04% = 0.08%)
    const commissionRate = 0.0008; // 0.08%
    const commission = notional * commissionRate;

    return pnlUsd - commission;
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
   * Manual sync trigger (for testing or emergency)
   */
  async manualSync(): Promise<{ synced: boolean; message: string }> {
    try {
      await this.reconcilePositions();
      return {
        synced: true,
        message: 'Manual reconciliation completed',
      };
    } catch (error) {
      return {
        synced: false,
        message: `Reconciliation failed: ${error.message}`,
      };
    }
  }
}
