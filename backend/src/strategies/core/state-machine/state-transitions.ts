import {
  PositionState,
  PositionEvent,
  PositionStateContext,
  ExitReason,
} from './position-state';

/**
 * State transition result
 */
export interface TransitionResult {
  /** New state after transition */
  newState: PositionState;

  /** Whether transition occurred */
  transitioned: boolean;

  /** Actions to perform after transition */
  actions: TransitionAction[];

  /** Updated context */
  context: PositionStateContext;
}

/**
 * Actions to perform after state transition
 *
 * These actions are executed by IActionExecutor implementations
 * (BacktestActionExecutor for backtesting, LiveActionExecutor for live trading)
 */
export type TransitionAction =
  | { type: 'PLACE_ENTRY_ORDER'; price: number; size: number }
  | { type: 'PLACE_SL_ORDER'; price: number }
  | { type: 'PLACE_TP1_ORDER'; price: number; size: number }
  | { type: 'CANCEL_ORDERS' }
  | { type: 'CLOSE_PARTIAL'; percent: number; reason: string }
  | { type: 'CLOSE_ALL'; reason: ExitReason }
  | { type: 'UPDATE_TRAILING_STOP'; price: number }
  | { type: 'MOVE_SL_TO_BREAKEVEN' }
  | { type: 'UPDATE_SL_ON_EXCHANGE'; price: number }
  | { type: 'CALCULATE_FUNDING_COST' }
  | { type: 'START_COOLDOWN' }
  | { type: 'LOG'; message: string };

/**
 * State transition table
 * Defines valid transitions and their effects
 */
const transitionTable: Record<
  PositionState,
  Partial<Record<PositionEvent, (ctx: PositionStateContext) => TransitionResult>>
> = {
  [PositionState.IDLE]: {
    [PositionEvent.SETUP_DETECTED]: (ctx) => ({
      newState: PositionState.SETUP,
      transitioned: true,
      actions: [{ type: 'LOG', message: `Setup detected for ${ctx.symbol}` }],
      context: { ...ctx, state: PositionState.SETUP },
    }),
  },

  [PositionState.SETUP]: {
    [PositionEvent.ENTRY_TRIGGER]: (ctx) => ({
      newState: PositionState.ENTRY_PENDING,
      transitioned: true,
      actions: [{ type: 'LOG', message: `Entry triggered for ${ctx.symbol}` }],
      context: { ...ctx, state: PositionState.ENTRY_PENDING },
    }),
    [PositionEvent.SETUP_INVALID]: (ctx) => ({
      newState: PositionState.IDLE,
      transitioned: true,
      actions: [{ type: 'LOG', message: `Setup invalidated for ${ctx.symbol}` }],
      context: { ...ctx, state: PositionState.IDLE },
    }),
    [PositionEvent.BAR_CLOSE]: (ctx) => {
      // Setup can expire after too many bars without entry trigger
      // This is strategy-specific and handled in the strategy implementation
      return {
        newState: PositionState.SETUP,
        transitioned: false,
        actions: [],
        context: ctx,
      };
    },
  },

  [PositionState.ENTRY_PENDING]: {
    [PositionEvent.ORDER_FILLED]: (ctx) => ({
      newState: PositionState.IN_POSITION,
      transitioned: true,
      actions: [
        { type: 'PLACE_SL_ORDER', price: ctx.slPrice! },
        { type: 'LOG', message: `Position opened for ${ctx.symbol} @ ${ctx.entryPrice}` },
      ],
      context: {
        ...ctx,
        state: PositionState.IN_POSITION,
        entryTime: Date.now(),
        barsSinceEntry: 0,
      },
    }),
    [PositionEvent.ORDER_CANCELLED]: (ctx) => ({
      newState: PositionState.IDLE,
      transitioned: true,
      actions: [{ type: 'LOG', message: `Entry order cancelled for ${ctx.symbol}` }],
      context: { ...ctx, state: PositionState.IDLE },
    }),
    [PositionEvent.SETUP_INVALID]: (ctx) => ({
      newState: PositionState.IDLE,
      transitioned: true,
      actions: [
        { type: 'CANCEL_ORDERS' },
        { type: 'LOG', message: `Entry cancelled - setup invalid for ${ctx.symbol}` },
      ],
      context: { ...ctx, state: PositionState.IDLE },
    }),
  },

  [PositionState.IN_POSITION]: {
    [PositionEvent.STOP_HIT]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.STOP_LOSS },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.STOP_LOSS,
      },
    }),
    [PositionEvent.TP1_HIT]: (ctx) => ({
      newState: PositionState.SCALE_OUT,
      transitioned: true,
      actions: [
        { type: 'CLOSE_PARTIAL', percent: 30, reason: 'TP1' },
        { type: 'MOVE_SL_TO_BREAKEVEN' },
        { type: 'UPDATE_SL_ON_EXCHANGE', price: ctx.entryPrice! },
        { type: 'LOG', message: `TP1 hit for ${ctx.symbol}, scaling out` },
      ],
      context: { ...ctx, state: PositionState.SCALE_OUT, tp1Hit: true },
    }),
    [PositionEvent.TIME_STOP]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.TIME_STOP },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.TIME_STOP,
      },
    }),
    [PositionEvent.OPPOSITE_SIGNAL]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.OPPOSITE_SIGNAL },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.OPPOSITE_SIGNAL,
      },
    }),
    [PositionEvent.BAR_CLOSE]: (ctx) => {
      const newBarsSinceEntry = ctx.barsSinceEntry + 1;

      // Check time stop
      if (ctx.timeStopBars && newBarsSinceEntry >= ctx.timeStopBars) {
        return {
          newState: PositionState.EXITED,
          transitioned: true,
          actions: [
            { type: 'CLOSE_ALL', reason: ExitReason.TIME_STOP },
            { type: 'START_COOLDOWN' },
          ],
          context: {
            ...ctx,
            state: PositionState.EXITED,
            barsSinceEntry: newBarsSinceEntry,
            exitReason: ExitReason.TIME_STOP,
          },
        };
      }

      return {
        newState: PositionState.IN_POSITION,
        transitioned: false,
        actions: [],
        context: { ...ctx, barsSinceEntry: newBarsSinceEntry },
      };
    },
  },

  [PositionState.SCALE_OUT]: {
    [PositionEvent.STOP_HIT]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.STOP_LOSS },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.STOP_LOSS,
      },
    }),
    [PositionEvent.BAR_CLOSE]: (ctx) => ({
      // Transition to trailing after scale out
      newState: PositionState.TRAILING,
      transitioned: true,
      actions: [{ type: 'LOG', message: `Trailing activated for ${ctx.symbol}` }],
      context: { ...ctx, state: PositionState.TRAILING },
    }),
    [PositionEvent.TIME_STOP]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.TIME_STOP },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.TIME_STOP,
      },
    }),
  },

  [PositionState.TRAILING]: {
    [PositionEvent.TRAIL_HIT]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.TRAILING_STOP },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.TRAILING_STOP,
      },
    }),
    [PositionEvent.TP2_HIT]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.TP2 },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.TP2,
      },
    }),
    [PositionEvent.TIME_STOP]: (ctx) => ({
      newState: PositionState.EXITED,
      transitioned: true,
      actions: [
        { type: 'CLOSE_ALL', reason: ExitReason.TIME_STOP },
        { type: 'START_COOLDOWN' },
      ],
      context: {
        ...ctx,
        state: PositionState.EXITED,
        exitReason: ExitReason.TIME_STOP,
      },
    }),
    [PositionEvent.BAR_CLOSE]: (ctx) => {
      const newBarsSinceEntry = ctx.barsSinceEntry + 1;

      // Check time stop
      if (ctx.timeStopBars && newBarsSinceEntry >= ctx.timeStopBars) {
        return {
          newState: PositionState.EXITED,
          transitioned: true,
          actions: [
            { type: 'CLOSE_ALL', reason: ExitReason.TIME_STOP },
            { type: 'START_COOLDOWN' },
          ],
          context: {
            ...ctx,
            state: PositionState.EXITED,
            barsSinceEntry: newBarsSinceEntry,
            exitReason: ExitReason.TIME_STOP,
          },
        };
      }

      return {
        newState: PositionState.TRAILING,
        transitioned: false,
        actions: [],
        context: { ...ctx, barsSinceEntry: newBarsSinceEntry },
      };
    },
  },

  [PositionState.EXITED]: {
    [PositionEvent.BAR_CLOSE]: (ctx) => ({
      newState: PositionState.COOLDOWN,
      transitioned: true,
      actions: [],
      context: {
        ...ctx,
        state: PositionState.COOLDOWN,
        cooldownStartTime: Date.now(),
      },
    }),
  },

  [PositionState.COOLDOWN]: {
    [PositionEvent.COOLDOWN_EXPIRED]: (ctx) => ({
      newState: PositionState.IDLE,
      transitioned: true,
      actions: [{ type: 'LOG', message: `Cooldown expired for ${ctx.symbol}` }],
      context: {
        ...ctx,
        state: PositionState.IDLE,
        tp1Hit: false,
        barsSinceEntry: 0,
        cooldownStartTime: undefined,
        exitReason: undefined,
        entryPrice: undefined,
        entryTime: undefined,
        positionSize: undefined,
        slPrice: undefined,
        tp1Price: undefined,
        trailingStopPrice: undefined,
      },
    }),
    [PositionEvent.BAR_CLOSE]: (ctx) => {
      // Track cooldown bars
      const cooldownBars = ctx.barsSinceEntry + 1;

      if (cooldownBars >= ctx.cooldownBars) {
        return {
          newState: PositionState.IDLE,
          transitioned: true,
          actions: [],
          context: {
            ...ctx,
            state: PositionState.IDLE,
            tp1Hit: false,
            barsSinceEntry: 0,
          },
        };
      }

      return {
        newState: PositionState.COOLDOWN,
        transitioned: false,
        actions: [],
        context: { ...ctx, barsSinceEntry: cooldownBars },
      };
    },
  },
};

/**
 * Process a state transition
 * @param context Current state context
 * @param event Event to process
 * @returns Transition result with new state and actions
 */
export function processTransition(
  context: PositionStateContext,
  event: PositionEvent,
): TransitionResult {
  const stateTransitions = transitionTable[context.state];

  if (!stateTransitions) {
    return {
      newState: context.state,
      transitioned: false,
      actions: [],
      context,
    };
  }

  const transitionFn = stateTransitions[event];

  if (!transitionFn) {
    return {
      newState: context.state,
      transitioned: false,
      actions: [],
      context,
    };
  }

  return transitionFn(context);
}

/**
 * Update trailing stop price
 * @param context Current context
 * @param currentPrice Current market price
 * @param atr Current ATR value
 * @param trailAtrMult ATR multiplier for trailing
 * @param direction Trade direction
 * @returns Updated context with new trailing stop price
 */
export function updateTrailingStop(
  context: PositionStateContext,
  currentPrice: number,
  atr: number,
  trailAtrMult: number,
  direction: 'LONG' | 'SHORT',
): PositionStateContext {
  if (context.state !== PositionState.TRAILING) {
    return context;
  }

  const newTrailStop =
    direction === 'LONG'
      ? currentPrice - atr * trailAtrMult
      : currentPrice + atr * trailAtrMult;

  // Only update if better (higher for long, lower for short)
  if (context.trailingStopPrice === undefined) {
    return { ...context, trailingStopPrice: newTrailStop };
  }

  if (direction === 'LONG' && newTrailStop > context.trailingStopPrice) {
    return { ...context, trailingStopPrice: newTrailStop };
  }

  if (direction === 'SHORT' && newTrailStop < context.trailingStopPrice) {
    return { ...context, trailingStopPrice: newTrailStop };
  }

  return context;
}
