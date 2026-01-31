import { Module } from '@nestjs/common';

// Core interfaces and utilities are exported directly, not as providers
// They are pure functions/classes without DI dependencies

// Strategy implementations
import { CoreTrendStrategy } from './core-trend/core-trend.strategy';
import { SqueezeStrategy } from './squeeze/squeeze.strategy';
import { FundingOverlay } from './funding-overlay/funding-overlay';

// Configs
import { CORE_TREND_CONFIG } from './core-trend/core-trend.config';
import { SQUEEZE_CONFIG } from './squeeze/squeeze.config';
import { FUNDING_OVERLAY_CONFIG } from './funding-overlay/funding-overlay';

/**
 * Strategy Service Factory
 * Creates strategy instances with configuration
 */
export class StrategyFactory {
  static createCoreTrend(config?: Partial<typeof CORE_TREND_CONFIG>): CoreTrendStrategy {
    return new CoreTrendStrategy(config);
  }

  static createSqueeze(config?: Partial<typeof SQUEEZE_CONFIG>): SqueezeStrategy {
    return new SqueezeStrategy(config);
  }

  static createFundingOverlay(config?: Partial<typeof FUNDING_OVERLAY_CONFIG>): FundingOverlay {
    return new FundingOverlay(config);
  }
}

/**
 * Strategy Provider tokens
 */
export const CORE_TREND_STRATEGY = 'CORE_TREND_STRATEGY';
export const SQUEEZE_STRATEGY = 'SQUEEZE_STRATEGY';
export const FUNDING_OVERLAY = 'FUNDING_OVERLAY';

@Module({
  providers: [
    // Core Trend Strategy
    {
      provide: CORE_TREND_STRATEGY,
      useFactory: () => StrategyFactory.createCoreTrend(),
    },
    // Squeeze Strategy
    {
      provide: SQUEEZE_STRATEGY,
      useFactory: () => StrategyFactory.createSqueeze(),
    },
    // Funding Overlay
    {
      provide: FUNDING_OVERLAY,
      useFactory: () => StrategyFactory.createFundingOverlay(),
    },
  ],
  exports: [
    CORE_TREND_STRATEGY,
    SQUEEZE_STRATEGY,
    FUNDING_OVERLAY,
  ],
})
export class StrategiesModule {}

// Re-export all interfaces and utilities for convenience
export * from './core/interfaces';
export * from './core/indicators';
export * from './core/state-machine/position-state';
export * from './core/state-machine/state-transitions';
export * from './core/risk/sizing';
export * from './core/risk/kill-switch';
export * from './core/risk/exposure-limiter';

// Re-export strategy classes
export { CoreTrendStrategy } from './core-trend/core-trend.strategy';
export { SqueezeStrategy } from './squeeze/squeeze.strategy';
export { FundingOverlay } from './funding-overlay/funding-overlay';

// Re-export configs
export { CORE_TREND_CONFIG, CoreTrendConfig } from './core-trend/core-trend.config';
export { SQUEEZE_CONFIG, SqueezeConfig } from './squeeze/squeeze.config';
export { FUNDING_OVERLAY_CONFIG, FundingOverlayConfig } from './funding-overlay/funding-overlay';
