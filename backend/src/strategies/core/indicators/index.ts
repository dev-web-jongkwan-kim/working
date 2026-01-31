// EMA (Exponential Moving Average)
export {
  calculateEMA,
  calculateEMAFromValues,
  calculateEMASeries,
  calculateEMASeriesFromValues,
  isEMABullish,
  detectEMACrossover,
} from './ema';

// ATR (Average True Range)
export {
  calculateTrueRange,
  calculateATR,
  calculateATRPercent,
  calculateATRSeries,
  calculateATRStopLoss,
  calculateTakeProfit,
} from './atr';

// Bollinger Bands Width
export {
  BollingerBands,
  calculateBollingerBands,
  calculateBBWidth,
  calculateBBWidthSeries,
  calculateBBWidthPercentile,
  detectBBCompression,
  detectBBExpansion,
} from './bb-width';

// ADX (Average Directional Index)
export {
  ADXResult,
  calculateADX,
  getTrendStrength,
  hasStrongTrend,
  getTrendDirection,
} from './adx';

// Funding Percentile
export {
  FundingOverlayAction,
  FundingAnalysis,
  calculateFundingPercentile,
  analyzeFunding,
  isFundingFavorable,
  adjustForFunding,
  calculateFundingZScore,
} from './funding-percentile';
