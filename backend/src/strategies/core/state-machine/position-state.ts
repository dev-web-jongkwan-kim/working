/**
 * Position State Machine
 * Based on improve.md specifications
 *
 * State flow:
 * IDLE → SETUP → ENTRY_PENDING → IN_POSITION → SCALE_OUT → TRAILING → EXITED → COOLDOWN
 */

/**
 * Position states
 */
export enum PositionState {
  /** No active setup or position */
  IDLE = 'IDLE',

  /** Setup conditions met, waiting for entry trigger */
  SETUP = 'SETUP',

  /** Entry order placed, waiting for fill */
  ENTRY_PENDING = 'ENTRY_PENDING',

  /** Position is open, SL/TP registered */
  IN_POSITION = 'IN_POSITION',

  /** TP1 hit, partial position closed */
  SCALE_OUT = 'SCALE_OUT',

  /** Trailing stop active for remaining position */
  TRAILING = 'TRAILING',

  /** Position fully closed */
  EXITED = 'EXITED',

  /** Cooldown period after exit */
  COOLDOWN = 'COOLDOWN',
}

/**
 * Position state events that trigger transitions
 */
export enum PositionEvent {
  /** New candle bar closed */
  BAR_CLOSE = 'BAR_CLOSE',

  /** Setup conditions detected */
  SETUP_DETECTED = 'SETUP_DETECTED',

  /** Entry trigger conditions met */
  ENTRY_TRIGGER = 'ENTRY_TRIGGER',

  /** Entry order filled */
  ORDER_FILLED = 'ORDER_FILLED',

  /** Stop loss hit */
  STOP_HIT = 'STOP_HIT',

  /** Take profit 1 hit */
  TP1_HIT = 'TP1_HIT',

  /** Take profit 2 or trailing stop hit */
  TP2_HIT = 'TP2_HIT',

  /** Trailing stop hit */
  TRAIL_HIT = 'TRAIL_HIT',

  /** Time-based stop triggered */
  TIME_STOP = 'TIME_STOP',

  /** Opposite signal detected */
  OPPOSITE_SIGNAL = 'OPPOSITE_SIGNAL',

  /** Cooldown period expired */
  COOLDOWN_EXPIRED = 'COOLDOWN_EXPIRED',

  /** Setup invalidated (conditions no longer valid) */
  SETUP_INVALID = 'SETUP_INVALID',

  /** Order cancelled */
  ORDER_CANCELLED = 'ORDER_CANCELLED',
}

/**
 * Exit reason for tracking
 */
export enum ExitReason {
  STOP_LOSS = 'STOP_LOSS',
  TP1 = 'TP1',
  TP2 = 'TP2',
  TRAILING_STOP = 'TRAILING_STOP',
  TIME_STOP = 'TIME_STOP',
  OPPOSITE_SIGNAL = 'OPPOSITE_SIGNAL',
  MANUAL = 'MANUAL',
  RISK_LIMIT = 'RISK_LIMIT',
  LIQUIDATION = 'LIQUIDATION',
}

/**
 * Position state context
 */
export interface PositionStateContext {
  /** Current state */
  state: PositionState;

  /** Symbol */
  symbol: string;

  /** Strategy type */
  strategyType: string;

  /** Entry time */
  entryTime?: number;

  /** Entry price */
  entryPrice?: number;

  /** Current position size */
  positionSize?: number;

  /** Stop loss price */
  slPrice?: number;

  /** TP1 price */
  tp1Price?: number;

  /** Whether TP1 has been hit */
  tp1Hit: boolean;

  /** Trailing stop price (if active) */
  trailingStopPrice?: number;

  /** Bars since entry (for time stop) */
  barsSinceEntry: number;

  /** Time stop bar limit */
  timeStopBars?: number;

  /** Cooldown start time */
  cooldownStartTime?: number;

  /** Cooldown duration in bars */
  cooldownBars: number;

  /** Exit reason (if exited) */
  exitReason?: ExitReason;
}

/**
 * Create initial position state context
 */
export function createInitialContext(
  symbol: string,
  strategyType: string,
  cooldownBars: number = 4,
  timeStopBars?: number,
): PositionStateContext {
  return {
    state: PositionState.IDLE,
    symbol,
    strategyType,
    tp1Hit: false,
    barsSinceEntry: 0,
    cooldownBars,
    timeStopBars,
  };
}

/**
 * Check if position is active (has open position)
 */
export function isPositionActive(context: PositionStateContext): boolean {
  return [
    PositionState.IN_POSITION,
    PositionState.SCALE_OUT,
    PositionState.TRAILING,
  ].includes(context.state);
}

/**
 * Check if can enter new position
 */
export function canEnterPosition(context: PositionStateContext): boolean {
  return context.state === PositionState.IDLE;
}

/**
 * Check if in cooldown
 */
export function isInCooldown(context: PositionStateContext): boolean {
  return context.state === PositionState.COOLDOWN;
}
