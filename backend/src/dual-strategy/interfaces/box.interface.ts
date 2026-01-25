/**
 * Box Range Strategy Interfaces
 * Defines types for box-based trading in sideways markets
 */

/**
 * Box Grade (A/B/C based on confidence)
 */
export type BoxGrade = 'A' | 'B' | 'C';

/**
 * Box Age Status
 */
export type BoxAgeStatus = 'FRESH' | 'OPTIMAL' | 'AGING' | 'EXPIRED';

/**
 * Box Swing Quality (based on swing point consistency)
 */
export type BoxSwingQuality = 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Volume Box Type (based on volume distribution)
 */
export type VolumeBoxType = 'CENTER_DOMINANT' | 'EDGE_DOMINANT' | 'UNSTRUCTURED';

/**
 * Swing Point Type
 */
export type SwingPointType = 'HIGH' | 'LOW';

/**
 * Swing Point (ZigZag peak/trough)
 */
export interface SwingPoint {
  index: number;
  price: number;
  timestamp: number;
  type: SwingPointType;
}

/**
 * Volume Profile Analysis
 */
export interface VolumeProfile {
  centerAvg: number;
  edgeAvg: number;
  isValid: boolean;
  ratio: number;
}

/**
 * Box Range Definition
 */
export interface BoxRange {
  symbol: string;
  upper: number;
  lower: number;
  height: number;
  heightAtrRatio: number;
  atr: number;

  // Swing points defining the box
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];

  // Swing consistency metrics
  swingQuality: BoxSwingQuality; // Quality grading: HIGH, MEDIUM, or LOW
  highDeviation: number; // High swing point deviation
  lowDeviation: number; // Low swing point deviation
  maxDeviationValue: number; // Maximum deviation

  // Time info
  formationTime: number;
  candlesInBox: number;

  // Technical indicators
  adx: number;
  plusDi: number;
  minusDi: number;

  // Volume analysis
  volumeProfile: VolumeProfile;

  // Grading
  confidence: number;
  grade: BoxGrade;
  ageStatus: BoxAgeStatus;

  // Status
  isValid: boolean;

  // 개선: 추가 메타데이터 (2026-01-24)
  volumeBoxType?: VolumeBoxType;  // Volume distribution type
  adxSizeMultiplier?: number;  // ADX-based size adjustment
  adxRequireConfirm?: boolean;  // Need confirm candle due to high ADX
  isExpandedBox?: boolean;  // Expanded box (4.5-6 ATR)
}

/**
 * Box Entry Zone
 */
export interface BoxEntryZone {
  isInLongZone: boolean;
  isInShortZone: boolean;
  distanceFromLower: number;
  distanceFromUpper: number;
  distanceFromLowerPercent: number;
  distanceFromUpperPercent: number;
}

/**
 * Box Entry Signal
 */
export interface BoxEntrySignal {
  detected: boolean;
  box: BoxRange;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;

  // Entry conditions
  rsi: number;
  candleType: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  momentumDecay: boolean;

  // Position sizing
  leverage: number;
  sizePercent: number;
  marginUsd: number;

  // Metadata
  confidence: number;
  fundingRate?: number;
  breachPercent?: number;

  // 2026-01-24 개선: 모드별 조정 정보
  beTarget?: number; // BE 이동 목표 (R 배수) - LowVolMode: 0.4R, ExpandedBox: 0.45R, Normal: 0.5R
  isLowVolMode?: boolean; // ATR% < 0.2% 저변동 모드
  isExpandedBox?: boolean; // 4.5-6 ATR 확장 박스
}

/**
 * Box Breakout Event
 */
export interface BoxBreakoutEvent {
  symbol: string;
  boxId: string;
  breakoutType: 'UPPER' | 'LOWER';
  breakoutPrice: number;
  boxBoundary: number;
  breachPercent: number;
  volumeMultiple: number;
  timestamp: number;
}

/**
 * Box Trade Result (for history)
 */
export interface BoxTradeResult {
  boxId: string;
  symbol: string;
  grade: BoxGrade;
  direction: 'LONG' | 'SHORT';

  entryPrice: number;
  exitPrice: number;
  exitReason: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'BREAKOUT' | 'TIMEOUT';

  pnl: number;
  pnlPercent: number;

  holdingMinutes: number;

  metadata: {
    boxUpper: number;
    boxLower: number;
    confidence: number;
    leverage: number;
  };
}

/**
 * Active Box Cache Entry
 */
export interface ActiveBoxCache {
  box: BoxRange;
  lastUpdated: number;
  disabledUntil?: number;
  disabledReason?: string;
}
