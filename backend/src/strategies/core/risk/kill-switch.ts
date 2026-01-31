/**
 * Kill Switch - Daily Loss Limit
 * Based on improve.md specifications:
 * - daily_loss_limit_pct: 0.01 (1%)
 * - Stops new entries when daily loss exceeds limit
 */

/**
 * Kill switch configuration
 */
export interface KillSwitchConfig {
  /** Daily loss limit as percentage of starting equity (e.g., 0.01 = 1%) */
  dailyLossLimitPct: number;

  /** Reset time in UTC hours (e.g., 0 for midnight UTC) */
  resetHourUtc: number;

  /** Whether to close all positions when triggered */
  closeAllOnTrigger: boolean;

  /** Cooldown period after trigger (in hours) */
  cooldownHours: number;
}

/**
 * Default kill switch configuration
 */
export const DEFAULT_KILL_SWITCH_CONFIG: KillSwitchConfig = {
  dailyLossLimitPct: 0.01, // 1%
  resetHourUtc: 0,         // Midnight UTC
  closeAllOnTrigger: false,
  cooldownHours: 4,
};

/**
 * Kill switch state
 */
export interface KillSwitchState {
  /** Whether kill switch is currently active */
  isActive: boolean;

  /** Current day's starting equity */
  dayStartEquity: number;

  /** Current day's realized P&L */
  realizedPnlToday: number;

  /** Timestamp when day started */
  dayStartTime: number;

  /** Timestamp when kill switch was triggered (if active) */
  triggerTime?: number;

  /** Reason for trigger */
  triggerReason?: string;
}

/**
 * Create initial kill switch state
 */
export function createKillSwitchState(currentEquity: number): KillSwitchState {
  return {
    isActive: false,
    dayStartEquity: currentEquity,
    realizedPnlToday: 0,
    dayStartTime: getDayStartTime(),
  };
}

/**
 * Get start of current day in UTC
 */
function getDayStartTime(resetHourUtc: number = 0): number {
  const now = new Date();
  const utcHours = now.getUTCHours();

  // If current hour is before reset hour, day started yesterday
  const dayStart = new Date(now);
  dayStart.setUTCHours(resetHourUtc, 0, 0, 0);

  if (utcHours < resetHourUtc) {
    dayStart.setUTCDate(dayStart.getUTCDate() - 1);
  }

  return dayStart.getTime();
}

/**
 * Check if we need to reset for a new day
 */
export function shouldResetDay(
  state: KillSwitchState,
  config: KillSwitchConfig = DEFAULT_KILL_SWITCH_CONFIG,
): boolean {
  const currentDayStart = getDayStartTime(config.resetHourUtc);
  return currentDayStart > state.dayStartTime;
}

/**
 * Reset kill switch for new day
 */
export function resetForNewDay(
  currentEquity: number,
  config: KillSwitchConfig = DEFAULT_KILL_SWITCH_CONFIG,
): KillSwitchState {
  return {
    isActive: false,
    dayStartEquity: currentEquity,
    realizedPnlToday: 0,
    dayStartTime: getDayStartTime(config.resetHourUtc),
  };
}

/**
 * Update kill switch state with a trade result
 */
export function updateWithTrade(
  state: KillSwitchState,
  pnlUsd: number,
  config: KillSwitchConfig = DEFAULT_KILL_SWITCH_CONFIG,
): KillSwitchState {
  // Check if we need to reset for new day
  if (shouldResetDay(state, config)) {
    // Get current equity (day start + realized today)
    const currentEquity = state.dayStartEquity + state.realizedPnlToday;
    state = resetForNewDay(currentEquity, config);
  }

  // Update realized P&L
  const newRealizedPnl = state.realizedPnlToday + pnlUsd;

  // Calculate loss limit
  const lossLimitUsd = state.dayStartEquity * config.dailyLossLimitPct;
  const shouldTrigger = newRealizedPnl <= -lossLimitUsd;

  return {
    ...state,
    realizedPnlToday: newRealizedPnl,
    isActive: shouldTrigger || state.isActive,
    triggerTime: shouldTrigger && !state.isActive ? Date.now() : state.triggerTime,
    triggerReason: shouldTrigger
      ? `Daily loss limit hit: ${newRealizedPnl.toFixed(2)} USD (limit: -${lossLimitUsd.toFixed(2)} USD)`
      : state.triggerReason,
  };
}

/**
 * Check if new entries are allowed
 */
export function canEnterNewPosition(
  state: KillSwitchState,
  config: KillSwitchConfig = DEFAULT_KILL_SWITCH_CONFIG,
): { allowed: boolean; reason?: string } {
  // Check if we need to reset for new day
  if (shouldResetDay(state, config)) {
    return { allowed: true };
  }

  // Check if kill switch is active
  if (state.isActive) {
    // Check if cooldown has passed
    if (state.triggerTime) {
      const cooldownMs = config.cooldownHours * 60 * 60 * 1000;
      const timeSinceTrigger = Date.now() - state.triggerTime;

      if (timeSinceTrigger < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - timeSinceTrigger) / 60000);
        return {
          allowed: false,
          reason: `Kill switch active. Cooldown: ${remainingMinutes} minutes remaining`,
        };
      }
    }

    return {
      allowed: false,
      reason: state.triggerReason || 'Kill switch active',
    };
  }

  // Check proximity to limit (warn at 80%)
  const lossLimitUsd = state.dayStartEquity * config.dailyLossLimitPct;
  const currentLoss = Math.abs(Math.min(state.realizedPnlToday, 0));
  const utilizationPercent = (currentLoss / lossLimitUsd) * 100;

  if (utilizationPercent >= 80) {
    return {
      allowed: true,
      reason: `Warning: ${utilizationPercent.toFixed(0)}% of daily loss limit used`,
    };
  }

  return { allowed: true };
}

/**
 * Get current kill switch status
 */
export function getKillSwitchStatus(
  state: KillSwitchState,
  config: KillSwitchConfig = DEFAULT_KILL_SWITCH_CONFIG,
): {
  isActive: boolean;
  dailyPnl: number;
  dailyPnlPercent: number;
  lossLimitUsd: number;
  utilizationPercent: number;
  hoursUntilReset: number;
} {
  const lossLimitUsd = state.dayStartEquity * config.dailyLossLimitPct;
  const currentLoss = Math.abs(Math.min(state.realizedPnlToday, 0));
  const utilizationPercent = lossLimitUsd > 0 ? (currentLoss / lossLimitUsd) * 100 : 0;

  // Calculate hours until reset
  const nextResetTime = getDayStartTime(config.resetHourUtc) + 24 * 60 * 60 * 1000;
  const hoursUntilReset = Math.max(0, (nextResetTime - Date.now()) / (60 * 60 * 1000));

  return {
    isActive: state.isActive,
    dailyPnl: state.realizedPnlToday,
    dailyPnlPercent:
      state.dayStartEquity > 0
        ? (state.realizedPnlToday / state.dayStartEquity) * 100
        : 0,
    lossLimitUsd,
    utilizationPercent,
    hoursUntilReset,
  };
}
