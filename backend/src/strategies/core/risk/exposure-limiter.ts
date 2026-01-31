/**
 * Exposure Limiter
 * Based on improve.md specifications:
 * - max_open_positions_total: 5
 * - max_same_direction_exposure: 0.7 (70%)
 */

/**
 * Exposure limiter configuration
 */
export interface ExposureLimiterConfig {
  /** Maximum total open positions */
  maxOpenPositions: number;

  /** Maximum exposure in same direction (e.g., 0.7 = 70% of total positions) */
  maxSameDirectionExposure: number;

  /** Maximum exposure per symbol (prevents over-concentration) */
  maxExposurePerSymbol: number;

  /** Maximum total exposure as percentage of equity */
  maxTotalExposurePercent: number;
}

/**
 * Default exposure limiter configuration
 */
export const DEFAULT_EXPOSURE_CONFIG: ExposureLimiterConfig = {
  maxOpenPositions: 5,
  maxSameDirectionExposure: 0.7,
  maxExposurePerSymbol: 0.3,          // 30% max in single symbol
  maxTotalExposurePercent: 1.0,       // 100% max total exposure
};

/**
 * Position info for exposure calculation
 */
export interface PositionInfo {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  positionSizeUsd: number;
  marginUsd: number;
}

/**
 * Exposure state
 */
export interface ExposureState {
  /** Current open positions */
  positions: PositionInfo[];

  /** Total long exposure in USD */
  totalLongExposure: number;

  /** Total short exposure in USD */
  totalShortExposure: number;

  /** Total margin used in USD */
  totalMarginUsed: number;
}

/**
 * Create initial exposure state
 */
export function createExposureState(positions: PositionInfo[] = []): ExposureState {
  const totalLongExposure = positions
    .filter((p) => p.direction === 'LONG')
    .reduce((sum, p) => sum + p.positionSizeUsd, 0);

  const totalShortExposure = positions
    .filter((p) => p.direction === 'SHORT')
    .reduce((sum, p) => sum + p.positionSizeUsd, 0);

  const totalMarginUsed = positions.reduce((sum, p) => sum + p.marginUsd, 0);

  return {
    positions,
    totalLongExposure,
    totalShortExposure,
    totalMarginUsed,
  };
}

/**
 * Check if a new position can be opened
 */
export function canOpenPosition(
  state: ExposureState,
  newPosition: PositionInfo,
  equity: number,
  config: ExposureLimiterConfig = DEFAULT_EXPOSURE_CONFIG,
): { allowed: boolean; reason?: string } {
  // Check max positions
  if (state.positions.length >= config.maxOpenPositions) {
    return {
      allowed: false,
      reason: `Max positions reached (${state.positions.length}/${config.maxOpenPositions})`,
    };
  }

  // Check if symbol already has position
  const existingSymbolPosition = state.positions.find(
    (p) => p.symbol === newPosition.symbol,
  );
  if (existingSymbolPosition) {
    return {
      allowed: false,
      reason: `Already have position in ${newPosition.symbol}`,
    };
  }

  // Check same direction exposure
  const sameDirectionCount = state.positions.filter(
    (p) => p.direction === newPosition.direction,
  ).length;
  const maxSameDirection = Math.floor(
    config.maxOpenPositions * config.maxSameDirectionExposure,
  );

  if (sameDirectionCount >= maxSameDirection) {
    return {
      allowed: false,
      reason: `Max ${newPosition.direction} positions reached (${sameDirectionCount}/${maxSameDirection})`,
    };
  }

  // Check per-symbol exposure
  const symbolExposurePercent = newPosition.positionSizeUsd / equity;
  if (symbolExposurePercent > config.maxExposurePerSymbol) {
    return {
      allowed: false,
      reason: `Position size ${(symbolExposurePercent * 100).toFixed(1)}% exceeds max per-symbol exposure ${(config.maxExposurePerSymbol * 100).toFixed(0)}%`,
    };
  }

  // Check total exposure
  const totalExposure =
    state.totalLongExposure +
    state.totalShortExposure +
    newPosition.positionSizeUsd;
  const totalExposurePercent = totalExposure / equity;

  if (totalExposurePercent > config.maxTotalExposurePercent) {
    return {
      allowed: false,
      reason: `Total exposure ${(totalExposurePercent * 100).toFixed(1)}% exceeds max ${(config.maxTotalExposurePercent * 100).toFixed(0)}%`,
    };
  }

  return { allowed: true };
}

/**
 * Add a position to the state
 */
export function addPosition(
  state: ExposureState,
  position: PositionInfo,
): ExposureState {
  const newPositions = [...state.positions, position];
  return createExposureState(newPositions);
}

/**
 * Remove a position from the state
 */
export function removePosition(
  state: ExposureState,
  symbol: string,
): ExposureState {
  const newPositions = state.positions.filter((p) => p.symbol !== symbol);
  return createExposureState(newPositions);
}

/**
 * Get exposure summary
 */
export function getExposureSummary(
  state: ExposureState,
  equity: number,
  config: ExposureLimiterConfig = DEFAULT_EXPOSURE_CONFIG,
): {
  positionCount: number;
  maxPositions: number;
  longCount: number;
  shortCount: number;
  longExposurePercent: number;
  shortExposurePercent: number;
  netExposurePercent: number;
  totalExposurePercent: number;
  marginUtilizationPercent: number;
  canOpenLong: boolean;
  canOpenShort: boolean;
} {
  const longCount = state.positions.filter((p) => p.direction === 'LONG').length;
  const shortCount = state.positions.filter((p) => p.direction === 'SHORT').length;
  const maxSameDirection = Math.floor(
    config.maxOpenPositions * config.maxSameDirectionExposure,
  );

  const totalExposure = state.totalLongExposure + state.totalShortExposure;
  const netExposure = state.totalLongExposure - state.totalShortExposure;

  return {
    positionCount: state.positions.length,
    maxPositions: config.maxOpenPositions,
    longCount,
    shortCount,
    longExposurePercent: equity > 0 ? (state.totalLongExposure / equity) * 100 : 0,
    shortExposurePercent: equity > 0 ? (state.totalShortExposure / equity) * 100 : 0,
    netExposurePercent: equity > 0 ? (netExposure / equity) * 100 : 0,
    totalExposurePercent: equity > 0 ? (totalExposure / equity) * 100 : 0,
    marginUtilizationPercent: equity > 0 ? (state.totalMarginUsed / equity) * 100 : 0,
    canOpenLong:
      state.positions.length < config.maxOpenPositions &&
      longCount < maxSameDirection,
    canOpenShort:
      state.positions.length < config.maxOpenPositions &&
      shortCount < maxSameDirection,
  };
}

/**
 * Calculate position scale factor based on current exposure
 * Reduces position size as exposure increases
 */
export function getPositionScaleFactor(
  state: ExposureState,
  direction: 'LONG' | 'SHORT',
  equity: number,
  config: ExposureLimiterConfig = DEFAULT_EXPOSURE_CONFIG,
): number {
  const sameDirectionCount = state.positions.filter(
    (p) => p.direction === direction,
  ).length;
  const maxSameDirection = Math.floor(
    config.maxOpenPositions * config.maxSameDirectionExposure,
  );

  if (maxSameDirection === 0) return 1;

  // Scale factor decreases as we approach max positions
  const utilizationRatio = sameDirectionCount / maxSameDirection;

  // Linear scaling: 100% at 0 positions, 50% at max positions
  return 1 - utilizationRatio * 0.5;
}

/**
 * Check BTC correlation exposure (for altcoins)
 * Reduces altcoin exposure when BTC direction is strong
 */
export function checkBtcCorrelationLimit(
  state: ExposureState,
  newSymbol: string,
  newDirection: 'LONG' | 'SHORT',
  btcDirection: 'UP' | 'DOWN' | 'NEUTRAL',
): { allowed: boolean; scaleFactor: number; reason?: string } {
  // Skip check for BTC itself
  if (newSymbol === 'BTCUSDT') {
    return { allowed: true, scaleFactor: 1 };
  }

  // If BTC direction is neutral, no correlation concern
  if (btcDirection === 'NEUTRAL') {
    return { allowed: true, scaleFactor: 1 };
  }

  // Count same-direction altcoin positions
  const sameDirectionAltcoins = state.positions.filter(
    (p) =>
      p.symbol !== 'BTCUSDT' &&
      p.direction === newDirection,
  ).length;

  // If BTC is trending in same direction, be cautious with altcoins
  const isSameAsBtc =
    (btcDirection === 'UP' && newDirection === 'LONG') ||
    (btcDirection === 'DOWN' && newDirection === 'SHORT');

  if (isSameAsBtc && sameDirectionAltcoins >= 2) {
    return {
      allowed: true,
      scaleFactor: 0.5, // Reduce size by 50%
      reason: `BTC correlation: ${sameDirectionAltcoins} altcoins already ${newDirection} with BTC ${btcDirection}`,
    };
  }

  return { allowed: true, scaleFactor: 1 };
}
