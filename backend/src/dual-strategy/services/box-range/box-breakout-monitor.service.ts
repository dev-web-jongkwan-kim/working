import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BOX_RANGE_CONFIG } from '../../constants/box-range.config';
import { BoxBreakoutEvent } from '../../interfaces/box.interface';
import { CustomLoggerService } from '../../../common/logging/custom-logger.service';
import { Position } from '../../../entities/position.entity';

/**
 * Box Breakout Monitor Service
 * Monitors active box range positions for breakouts
 * Triggers emergency position closure on box invalidation
 */
@Injectable()
export class BoxBreakoutMonitorService {
  private readonly config = BOX_RANGE_CONFIG.breakoutProtection;

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly logger: CustomLoggerService,
  ) {}

  /**
   * Monitor position for box breakout
   * Call this on price updates for active box range positions
   */
  async monitorBreakout(
    position: Position,
    currentPrice: number,
    currentVolume: number,
  ): Promise<BoxBreakoutEvent | null> {
    const { symbol } = position;

    // Extract box boundaries from position metadata
    const boxUpper = position.metadata?.boxUpper;
    const boxLower = position.metadata?.boxLower;

    if (!boxUpper || !boxLower) {
      this.logger.debug(
        `[BoxBreakout] ${symbol} Position missing box metadata, skipping monitor`,
        'BoxBreakoutMonitor',
      );
      return null;
    }

    // Check for breakout
    const breachPercent = this.config.thresholdPercent;

    const upperBreakoutPrice = boxUpper * (1 + breachPercent);
    const lowerBreakoutPrice = boxLower * (1 - breachPercent);

    let breakoutType: 'UPPER' | 'LOWER' | null = null;
    let boxBoundary: number;

    if (currentPrice > upperBreakoutPrice) {
      breakoutType = 'UPPER';
      boxBoundary = boxUpper;
    } else if (currentPrice < lowerBreakoutPrice) {
      breakoutType = 'LOWER';
      boxBoundary = boxLower;
    }

    if (!breakoutType) {
      // No breakout, check for early warning (volume surge)
      if (this.config.earlyWarning.enabled) {
        await this.checkEarlyWarning(position, currentVolume);
      }
      return null;
    }

    // Breakout detected!
    const actualBreachPercent = breakoutType === 'UPPER'
      ? (currentPrice - boxUpper) / boxUpper
      : (boxLower - currentPrice) / boxLower;

    this.logger.log(
      `[BoxBreakout] ${symbol} 💥 BREAKOUT DETECTED! ` +
        `Type=${breakoutType}, price=${currentPrice.toFixed(2)}, ` +
        `boundary=${boxBoundary.toFixed(2)}, breach=${(actualBreachPercent * 100).toFixed(2)}%`,
      'BoxBreakoutMonitor',
    );

    const breakoutEvent: BoxBreakoutEvent = {
      symbol,
      boxId: position.id,
      breakoutType,
      breakoutPrice: currentPrice,
      boxBoundary,
      breachPercent: actualBreachPercent,
      volumeMultiple: 1, // Could calculate from volume data
      timestamp: Date.now(),
    };

    // Emit breakout event for emergency closure
    this.eventEmitter.emit('box.breakout', breakoutEvent);

    return breakoutEvent;
  }

  /**
   * Check for early warning signs (volume surge)
   */
  private async checkEarlyWarning(position: Position, currentVolume: number): Promise<void> {
    const { symbol } = position;
    const avgVolume = position.metadata?.avgVolume;

    if (!avgVolume) {
      return;
    }

    const volumeMultiple = currentVolume / avgVolume;

    if (volumeMultiple >= this.config.earlyWarning.volumeMultiplier) {
      this.logger.log(
        `[BoxBreakout] ${symbol} ⚠️ Early warning! Volume surge: ${volumeMultiple.toFixed(2)}x average`,
        'BoxBreakoutMonitor',
      );

      // Emit early warning event
      this.eventEmitter.emit('box.early_warning', {
        symbol,
        positionId: position.id,
        volumeMultiple,
        action: this.config.earlyWarning.action,
      });
    }
  }

  /**
   * Check if position should be closed due to box breakout
   */
  shouldClosePosition(
    position: Position,
    currentPrice: number,
  ): { shouldClose: boolean; reason?: string } {
    const boxUpper = position.metadata?.boxUpper;
    const boxLower = position.metadata?.boxLower;

    if (!boxUpper || !boxLower) {
      return { shouldClose: false };
    }

    const breachPercent = this.config.thresholdPercent;
    const upperBreakoutPrice = boxUpper * (1 + breachPercent);
    const lowerBreakoutPrice = boxLower * (1 - breachPercent);

    if (currentPrice > upperBreakoutPrice) {
      return {
        shouldClose: true,
        reason: `Upper box breakout (${currentPrice.toFixed(2)} > ${upperBreakoutPrice.toFixed(2)})`,
      };
    }

    if (currentPrice < lowerBreakoutPrice) {
      return {
        shouldClose: true,
        reason: `Lower box breakout (${currentPrice.toFixed(2)} < ${lowerBreakoutPrice.toFixed(2)})`,
      };
    }

    return { shouldClose: false };
  }

  /**
   * Calculate breakout severity (for logging/alerts)
   */
  calculateBreakoutSeverity(
    boxBoundary: number,
    currentPrice: number,
    breakoutType: 'UPPER' | 'LOWER',
  ): 'MINOR' | 'MODERATE' | 'SEVERE' {
    const breachPercent = Math.abs(currentPrice - boxBoundary) / boxBoundary;

    if (breachPercent < 0.01) {
      return 'MINOR'; // < 1%
    } else if (breachPercent < 0.02) {
      return 'MODERATE'; // 1-2%
    } else {
      return 'SEVERE'; // > 2%
    }
  }
}
