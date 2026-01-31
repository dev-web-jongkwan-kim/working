# Trading System Specification

> 바이낸스 선물 자동 트레이딩 시스템 상세 스펙
>
> Last Updated: 2026-01-26

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Strategy A: Cycle Rider](#2-strategy-a-cycle-rider)
3. [Strategy B: Hour Swing](#3-strategy-b-hour-swing)
4. [Strategy C: Box Range](#4-strategy-c-box-range)
5. [Signal Flow](#5-signal-flow)
6. [Risk Management](#6-risk-management)
7. [Performance Metrics](#7-performance-metrics)

---

## 1. System Overview

### 1.1 Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Binance Futures API                          │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
          ┌─────────────────┐         ┌─────────────────┐
          │  REST API       │         │  WebSocket      │
          │  (Candles,      │         │  (User Data     │
          │   Exchange Info)│         │   Stream)       │
          └────────┬────────┘         └────────┬────────┘
                   │                           │
                   ▼                           ▼
          ┌─────────────────┐         ┌─────────────────┐
          │ Data Collector  │         │ User Data       │
          │ Service         │         │ Stream Service  │
          │ (1m,5m,15m,1h)  │         │ (Order Updates) │
          └────────┬────────┘         └────────┬────────┘
                   │                           │
                   ▼                           │
          ┌─────────────────┐                  │
          │ Dual Strategy   │                  │
          │ Orchestrator    │                  │
          └────────┬────────┘                  │
                   │                           │
     ┌─────────────┼─────────────┐             │
     ▼             ▼             ▼             │
┌─────────┐  ┌─────────┐  ┌─────────┐          │
│ Cycle   │  │ Hour    │  │ Box     │          │
│ Rider   │  │ Swing   │  │ Range   │          │
│ Signal  │  │ Signal  │  │ Signal  │          │
└────┬────┘  └────┬────┘  └────┬────┘          │
     │            │            │               │
     └────────────┴────────────┘               │
                   │                           │
                   ▼                           │
          ┌─────────────────┐                  │
          │ Signal Queue    │                  │
          │ Service         │                  │
          └────────┬────────┘                  │
                   │                           │
                   ▼                           │
          ┌─────────────────┐                  │
          │ Order Executor  │◄─────────────────┘
          │ Service         │
          └────────┬────────┘
                   │
                   ▼
          ┌─────────────────┐
          │ Position        │
          │ Manager         │
          └─────────────────┘
```

### 1.2 Monitoring Scope

| Item | Value |
|------|-------|
| Symbols | Top 100 by 24h volume |
| Timeframes | 1m, 5m, 15m, 1h |
| Signal Scan | Every 30 minutes (00, 30) |
| 1m Entry Check | Every 1 minute (active signals only) |
| Server Port | 4040 |

### 1.3 Strategy Summary

| Strategy | Goal | Leverage | Margin | Max Positions | Hold Time |
|----------|------|----------|--------|---------------|-----------|
| **Cycle Rider** | Trend cycle capture | 15x | $50 | 5 | 30m ~ 4h |
| **Hour Swing** | Quick swing profits | 10x | $15 | 3 | 10m ~ 60m |
| **Box Range** | Sideways reversal | 9~15x | $30 | 4 | Variable |

---

## 2. Strategy A: Cycle Rider

### 2.1 Overview

- **Goal**: Capture entire trend cycles with large R:R trades
- **Timeframe**: 15m (signal), 1m (entry)
- **Style**: Trend following with climax reversal

### 2.2 Position Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `leverage` | 15x | Higher for trend-confirmed entries |
| `marginUsd` | $50 | Per trade margin |
| `maxPositions` | 5 | Maximum concurrent positions |
| `maxSameDirection` | 3 | Max same direction positions |
| `minHoldMinutes` | 30 | Minimum hold time |
| `maxHoldMinutes` | 240 | Maximum hold time (4 hours) |
| `tp1ClosePercent` | 25% | Close 25% at TP1 |
| `cooldownMinutes` | 30 | Cooldown after SL hit |

### 2.3 Common Filters

| Filter | Value | Description |
|--------|-------|-------------|
| `maxConsecutiveBars` | 3 | Prevent late entry (critical) |
| `minAtrPercent` | 0.45% | Min volatility threshold |
| `maxAtrPercent` | 3.0% | Max volatility threshold |
| `maxSpreadPercent` | 0.07% | Max spread allowed |
| `maxAbsFundingRate` | 0.1% | Warning threshold |
| `minVolumeRank` | 30% | Top 70% by volume |

### 2.4 Regime RSI Filter

Prevents counter-trend entries without extreme RSI:

| Regime | Direction | RSI Condition |
|--------|-----------|---------------|
| STRONG_DOWNTREND | LONG | RSI < 20 only |
| WEAK_DOWNTREND | LONG | RSI < 30 only |
| WEAK_UPTREND | SHORT | RSI > 70 only |
| STRONG_UPTREND | SHORT | RSI > 80 only |

### 2.5 Trailing Stop

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Trailing stop active |
| `activateAfterTp1` | true | Activate after TP1 hit |
| `distanceAtr` | 2.5 ATR | Distance from high/low |
| `stepAtr` | 0.3 ATR | Step size |

### 2.6 Sub-Strategies

#### 2.6.1 Volume Climax

**Concept**: Enter counter-direction after extreme volume exhaustion

**Detection Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `volumeAvgPeriod` | 20 | Volume average lookback |
| `minVolumeMultiple` | 2.0x | Min volume spike |
| `minCandleSizeAtr` | 1.4 ATR | Min candle size |
| `rsiPeriod` | 14 | RSI calculation period |
| `rsiBuyingClimax` | >= 75 | RSI for buying climax (SHORT) |
| `rsiSellingClimax` | <= 25 | RSI for selling climax (LONG) |
| `entryDelay` | 2 bars | Wait after climax |
| `minTrendBars` | 5 | Min trend duration |

**Re-entry RSI Confirmation**:
| Direction | Condition |
|-----------|-----------|
| LONG | RSI still < 35 at entry |
| SHORT | RSI still > 65 at entry |

**SL/TP**:
| Parameter | Value |
|-----------|-------|
| `slAtrMultiple` | 1.0 ATR |
| `tp1RR` | 1.5 R:R |
| `tp2RR` | 4.0 R:R |
| `useTrailing` | false |

**Signal Flow**:
```
1. Detect volume spike (>= 2.0x avg)
2. Check candle size (>= 1.4 ATR)
3. Check RSI extreme (>= 75 or <= 25)
4. Wait 2 bars for confirmation
5. Re-check RSI still extreme
6. Generate signal with calculated SL/TP
```

#### 2.6.2 Squeeze (Bollinger/Keltner)

**Concept**: Enter when BB squeezes inside KC, momentum ready to explode

**Detection Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `bbPeriod` | 20 | Bollinger Band period |
| `bbStdDev` | 2.0 | Bollinger Band std dev |
| `kcPeriod` | 20 | Keltner Channel period |
| `kcAtrMultiple` | 1.5 | KC ATR multiple |
| `minSqueezeBars` | 6 | Min squeeze duration |
| `momentumPeriod` | 12 | Momentum calculation |
| `minMomentumStrength` | 30 | Min momentum strength |
| `minAdx` | 18 | Min ADX (trend forming) |
| `minRvol` | 1.5x | Min relative volume |

**SL/TP**:
| Parameter | Value |
|-----------|-------|
| `slAtrMultiple` | 1.0 ATR |
| `tp1AtrMultiple` | 2.0 ATR |
| `tp2AtrMultiple` | 3.0 ATR |
| `useTrailing` | true |

#### 2.6.3 Accumulation (Wyckoff)

**Concept**: Detect smart money accumulation at support

**Detection Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `boxPeriod` | 20 | Box lookback |
| `boxRangeMaxAtr` | 2.0 ATR | Max box range |
| `supportTestThreshold` | 0.3% | Support test tolerance |
| `minSupportTests` | 2 | Min support touches |
| `cvdPeriod` | 10 | CVD calculation |
| `cvdSlopeThreshold` | 0.025 | Min CVD slope (accumulation) |
| `springBreakPercent` | 1% | Spring break below support |
| `springMaxBreakPercent` | 3% | Max spring break |
| `springRecoveryBars` | 3 | Recovery within 3 bars |
| `springVolumeMultiple` | 1.5x | Spring volume spike |
| `minConfidence` | 70 | Min confidence score |

**SL/TP**:
| Parameter | Value |
|-----------|-------|
| `slAtrMultiple` | 0.3 ATR |
| `tp1Type` | Box top |
| `tp2Type` | Box top + range |
| `useTrailing` | true |

#### 2.6.4 Distribution (Inverse Wyckoff)

**Concept**: Detect smart money distribution at resistance

Same parameters as Accumulation but inverted:
- CVD slope threshold: -0.025 (distribution)
- UTAD (upthrust after distribution) detection
- SHORT direction

#### 2.6.5 Divergence

**Concept**: RSI/CVD divergence from price

**Detection Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `swingLookback` | 5 | Swing detection lookback |
| `minSwingDistance` | 10 bars | Min swing distance |
| `maxSwingDistance` | 50 bars | Max swing distance |
| `rsiPeriod` | 14 | RSI period |
| `rsiOversold` | 30 | Oversold level |
| `rsiOverbought` | 70 | Overbought level |
| `priceDivergenceMin` | 0.5% | Min price divergence |
| `minIndicatorsConfirm` | 2 | Min confirming indicators |

**Confirmation Patterns**: HAMMER, INVERTED_HAMMER, BULLISH_ENGULFING, BEARISH_ENGULFING, MORNING_STAR, EVENING_STAR

**SL/TP**:
| Parameter | Value |
|-----------|-------|
| `slAtrMultiple` | 1.0 ATR |
| `tp1RR` | 2.0 R:R |
| `tp2RR` | 3.0 R:R |
| `useTrailing` | true |

---

## 3. Strategy B: Hour Swing

### 3.1 Overview

- **Goal**: Quick confirmed profits within 1 hour
- **Timeframe**: 1h/15m/5m (MTF alignment)
- **Style**: Pullback entry in established trend

### 3.2 Position Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `leverage` | 10x | Reduced for safety (was 12x) |
| `marginUsd` | $15 | Reduced after 6 consecutive losses |
| `maxPositions` | 3 | Maximum concurrent positions |
| `maxSameDirection` | 2 | Max same direction positions |
| `minHoldMinutes` | 10 | Minimum hold time |
| `maxHoldMinutes` | 60 | Maximum hold time |
| `tp1ClosePercent` | 50% | Close 50% at TP1 |
| `cooldownMinutes` | 15 | Cooldown after trade |

### 3.3 Breakeven Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Move SL to entry |
| `activateAtRR` | 1.0 R:R | Activate at 1R profit |
| `moveSlToEntry` | true | Move SL to entry price |

### 3.4 ATR Filters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `minAtrPercent` | 0.5% | Min volatility |
| `maxAtrPercent` | 3.5% | Max volatility |
| `atrPeriod` | 14 | ATR calculation period |

### 3.5 Regime Filter

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Regime filtering active |
| `blockCounterTrend` | true | Block counter-trend trades |
| `blockWeakCounterTrend` | true | Block even in WEAK trends |
| `sidewaysOff` | true | **Completely OFF in SIDEWAYS** |

**Regime Blocking Matrix**:
| Regime | LONG | SHORT |
|--------|------|-------|
| STRONG_UPTREND | ✅ | ❌ |
| WEAK_UPTREND | ✅ | ❌ |
| SIDEWAYS | ❌ | ❌ |
| WEAK_DOWNTREND | ❌ | ✅ |
| STRONG_DOWNTREND | ❌ | ✅ |

### 3.6 Loss-Streak Kill Switch

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Kill switch active |
| `maxConsecutiveLosses` | 3 | Trigger after 3 SL hits |
| `cooldownMinutes` | 60 | 60 minute cooldown |

### 3.7 Concurrent Entry Limit

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Limit simultaneous entries |
| `maxEntriesWithinWindow` | 2 | Max 2 entries |
| `windowMinutes` | 5 | Within 5 minute window |

### 3.8 Sub-Strategies

#### 3.8.1 MTF Alignment + Pullback

**Concept**: Enter pullback when H1/M15/M5 trends align

**H1 (1-hour) Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `trendBars` | 6 | Trend lookback |
| `minStrength` | 0.07 | Min trend strength |
| `maxStrength` | 0.5 | Not too advanced |
| `maxConsecutiveBars` | 3 | **Critical: prevent late entry** |
| `emaPeriod` | 20 | EMA period |

**M15 (15-minute) Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `trendBars` | 4 | Trend lookback |
| `minStrength` | 0.2 | Min trend strength |
| `maxStrength` | 0.6 | Max trend strength |
| `mustAlignWithH1` | true | Must match H1 direction |

**M5 (5-minute) Pullback Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `pullbackBars` | 3 | Pullback detection bars |
| `minPullbackDepthAtr` | 0.6 ATR | Min pullback depth |
| `maxPullbackDepthAtr` | 1.0 ATR | Max pullback depth |
| `cvdConfirmBars` | 3 | CVD confirmation bars |
| `cvdMinRatio` | 5% | Min CVD ratio |
| `requireConfirmCandle` | true | Require confirmation candle |

**RSI Filter** (Prevent overbought/oversold entry):
| Direction | Condition | Description |
|-----------|-----------|-------------|
| LONG | RSI <= 65 | Block if overbought |
| SHORT | RSI >= 35 | Block if oversold |

**Funding Filter**:
| Direction | Max Funding | Description |
|-----------|-------------|-------------|
| LONG | < +0.03% | High funding = crowded long |
| SHORT | > -0.03% | Low funding = crowded short |

**SL/TP**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `slAtrMultiple` | 1.2 ATR | SL distance |
| `minSlPercent` | 0.8% | Min SL percentage |
| `maxSlPercent` | 2.0% | Max SL percentage |
| `tp1RR` | 1.0 R:R | TP1 target |
| `tp2RR` | 1.5 R:R | TP2 target |

**Signal Flow**:
```
1. Check H1 trend (strength 0.07~0.5, consecutive <= 3)
2. Check M15 alignment with H1
3. Detect M5 pullback (0.6~1.0 ATR depth)
4. Confirm CVD direction (5% ratio)
5. Check RSI not extreme (35~65)
6. Check funding rate filter
7. Wait for confirmation candle
8. Generate signal with SL/TP
```

#### 3.8.2 Relative Strength Leader

**Concept**: Trade symbols outperforming/underperforming BTC

**Detection Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `rsPeriod` | 12 hours | RS calculation period |
| `rsTimeframe` | 1h | RS timeframe |
| `topRsCount` | 15 | Top RS symbols for LONG |
| `bottomRsCount` | 15 | Bottom RS symbols for SHORT |
| `btcTurnConfirmBars` | 2 | BTC turn confirmation |
| `btcEmaFast` | 7 | BTC fast EMA |
| `btcEmaSlow` | 20 | BTC slow EMA |
| `requirePullback` | true | Require pullback |
| `cvdConfirmRequired` | true | Require CVD confirmation |
| `minDailyVolume` | $50M | Min 24h volume |

**SL/TP**:
| Parameter | Value |
|-----------|-------|
| `slAtrMultiple` | 1.0 ATR |
| `tp1RR` | 1.5 R:R |
| `tp2RR` | 2.0 R:R |

#### 3.8.3 Funding Extremes

**Concept**: Counter-trend when funding rate is extreme

**Detection Conditions**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| `fundingHistoryPeriod` | 168 hours | 7 days history |
| `extremeZScore` | 2.0 | 2 standard deviations |
| `extremeHighAbsolute` | +0.05% | Extreme high (SHORT signal) |
| `extremeLowAbsolute` | -0.05% | Extreme low (LONG signal) |
| `momentumSlowingBars` | 2 | Momentum slowing detection |
| `rsiOverbought` | 70 | RSI overbought |
| `rsiOversold` | 30 | RSI oversold |
| `confirmationRequired` | true | Require price confirmation |

**Signal Logic**:
| Funding | RSI | Signal |
|---------|-----|--------|
| > +0.05% | > 70 | SHORT (crowded longs) |
| < -0.05% | < 30 | LONG (crowded shorts) |

**SL/TP**:
| Parameter | Value |
|-----------|-------|
| `slAtrMultiple` | 1.0 ATR |
| `tp1RR` | 1.8 R:R |
| `tp2RR` | 2.5 R:R |

---

## 4. Strategy C: Box Range

### 4.1 Overview

- **Goal**: Trade sideways market box boundaries
- **Timeframe**: 15m
- **Style**: Mean reversion at support/resistance

### 4.2 Position Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `baseLeverage` | 15x | Adjusted by grade (A:15, B:12, C:9) |
| `marginUsd` | $30 | Per trade margin |
| `maxPositions` | 4 | Maximum concurrent positions |
| `maxSameDirection` | 1 | Max same direction (prevent double loss) |
| `cooldownMinutes` | 15 | Re-entry cooldown |

### 4.3 Box Definition

#### 4.3.1 Swing Point Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `depth` | 5 | ZigZag depth (candles left/right) |
| `minHighs` | 2 | Minimum swing highs |
| `minLows` | 2 | Minimum swing lows |
| `maxDeviationAtr` | 2.0 | Max swing deviation |
| `minAbsoluteDeviation` | 0.06 | Min absolute deviation |
| `highQualityMaxDeviation` | 0.05 | HIGH quality threshold |
| `mediumQualityMaxDeviation` | 0.06 | MEDIUM quality threshold |

#### 4.3.2 Box Height by Symbol Type

| Type | Symbols | Min ATR | Max ATR | Optimal |
|------|---------|---------|---------|---------|
| Stable | BTC, ETH | 1.5 | 3.0 | 1.5~2.5 |
| Altcoin | Auto-detect | 1.5 | 6.0 | 2.0~4.5 |
| High Volatility | Auto-detect | 2.0 | 6.0 | 3.0~5.0 |

#### 4.3.3 Box Time Conditions

| Parameter | Value (candles) | Time (15m) |
|-----------|-----------------|------------|
| `minCandles` | 20 | 5 hours |
| `warningCandles` | 48 | 12 hours |
| `maxCandles` | 72 | 18 hours |
| `expireCandles` | 96 | 24 hours |

#### 4.3.4 Expanded Box Rules (4.5~6.0 ATR)

| Parameter | Value | Description |
|-----------|-------|-------------|
| `sizeMultiplier` | 60% | Reduced position size |
| `entryZonePercent` | 15% | Narrower entry zone |
| `tpRatio` | 70% | Shorter TP target |
| `requireConfirmCandle` | true | Must have confirm candle |

### 4.4 ADX Conditions

| Parameter | Value | Description |
|-----------|-------|-------------|
| `maxValue` | 28 | Max ADX for entry |
| `maxDiDiff` | 10 | Max |+DI - -DI| |
| `requireDeclining` | false | Absolute value only |

**Soft Blocking (Size Adjustment)**:
| ADX Level | Action |
|-----------|--------|
| > 40 | Complete block |
| > 35 | 50% size |
| > 30 | 70% size |
| > 28 | 100% size (normal) |
| > 25 | Require confirmation candle |

### 4.5 Volume Profile

| Parameter | Value | Description |
|-----------|-------|-------------|
| `useAsBlocking` | false | Score only, no blocking |
| `lookbackCandles` | 50 | Analysis period |

**Box Type Classification**:
| Type | Condition | Score |
|------|-----------|-------|
| Center Dominant | center > 60% | Higher |
| Edge Dominant | edge > center × 1.3 | Medium |
| Unstructured | threshold < 0.4 | Lower |

### 4.6 Entry Conditions

| Parameter | Value | Description |
|-----------|-------|-------------|
| `entryZonePercent` | 25% | Upper/Lower 25% zone |
| `maxConsecutiveBars` | 3 | Prevent chase entry |

#### 4.6.1 SFP (Sweep/Fake Breakout) Filter

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | SFP detection active |
| `minBreachPercent` | 0.3% | Min breach for SFP |
| `maxBreachPercent` | 0.8% | Max breach for SFP |
| `returnCandleCount` | 2 | Must return within 2 candles |

#### 4.6.2 RSI Slope Filter

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | RSI slope check |
| `lookbackCandles` | 3 | Check last 3 candles |
| `maxChange` | 30 | Max 30-point change |

#### 4.6.3 Volume Decay Filter

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Volume decay check |
| `maxVolumeRatio` | 2.3x | Max 130% volume increase |
| `lookbackCandles` | 20 | Average period |

#### 4.6.4 Direction-Specific Conditions

**LONG Entry** (at box bottom):
| Parameter | Value |
|-----------|-------|
| `maxRsi` | < 35 |
| `requireBullishCandle` | true |
| `maxBreachPercent` | 0.2% below box |

**SHORT Entry** (at box top):
| Parameter | Value |
|-----------|-------|
| `minRsi` | > 65 |
| `requireBearishCandle` | true |
| `maxBreachPercent` | 0.2% above box |

### 4.7 SL/TP Settings

| Parameter | Value | Description |
|-----------|-------|-------------|
| `slBufferAtr` | 0.5 ATR | SL buffer beyond box |

**TP1**:
| Parameter | Value |
|-----------|-------|
| `usePOC` | true (Volume POC) |
| `fallbackPercent` | 50% of box |
| `closePercent` | 70% |

**TP2**:
| Parameter | Value |
|-----------|-------|
| `targetPercent` | 90% of box |
| `closePercent` | 30% |
| `useTrailingStop` | true |
| `trailingStopAtr` | 0.5 ATR |

**After TP1**:
| Parameter | Value |
|-----------|-------|
| `moveSlToEntryAfterTp1` | true |
| `slBreakevenBuffer` | +0.1% |

### 4.8 Box Grading System

| Grade | Min Confidence | Leverage | Size | Allowed Hours (KST) |
|-------|----------------|----------|------|---------------------|
| A | 85 | 15x | 100% | 0~24 (all) |
| B | 70 | 12x | 75% | 9AM~11PM |
| C | 60 | 9x | 50% | 9AM~3PM |
| Reject | < 60 | - | - | - |

**Confidence Scoring**:
| Factor | Max Points |
|--------|------------|
| Touch Count | 25 (5 per touch) |
| ADX Score | 25 (<15: 25, <20: 20, <25: 10) |
| Box Height | 25 (2-3 ATR optimal) |
| Age Score | 25 (6-12h optimal) |
| **Total** | **100** |

### 4.9 Time Filter

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Time filtering active |
| `disabledHours.start` | 22:00 KST | US market open volatility |
| `disabledHours.end` | 00:30 KST | First 2.5 hours blocked |

### 4.10 Funding Bias

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Funding filter active |
| `threshold` | 0.08% | Moderate threshold |
| `extremeThreshold` | 0.08% | Block counter-direction |

**Blocking Rules**:
| Funding | Blocked Direction |
|---------|-------------------|
| > +0.08% | LONG |
| < -0.08% | SHORT |

### 4.11 Same-Box Loss Limiter

| Parameter | Value | Description |
|-----------|-------|-------------|
| `enabled` | true | Loss limiter active |
| `maxConsecutiveLosses` | 2 | Max 2 SL in same box |
| `cooldownMinutes` | 120 | 2 hour cooldown |
| `invalidateBox` | true | Invalidate the box |

### 4.12 Low Volatility Mode

Triggered when ATR% < 0.2%:

| Parameter | Value |
|-----------|-------|
| `sizeMultiplier` | 60% |
| `tp1Ratio` | 0.6 R:R |
| `beActivateRatio` | 0.4 R:R |
| `requireConfirmCandle` | true |

### 4.13 Viability Filter

**TP Distance Minimum**:
| Symbol Type | Min TP Distance |
|-------------|-----------------|
| Major | 0.18% |
| Altcoin | 0.25% |

**Spread Maximum**:
| Symbol Type | Max Spread |
|-------------|------------|
| Major | 0.03% |
| Altcoin | 0.06% |

Major symbols: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT

---

## 5. Signal Flow

### 5.1 Signal Generation (Every 30 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                    Signal Generation Flow                        │
└─────────────────────────────────────────────────────────────────┘

[00:00 / 00:30] Cron Trigger
        │
        ▼
┌───────────────────┐
│ Fetch Latest      │
│ Candles (15m, 1h) │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ Market Regime     │
│ Classification    │
│ (ATR, ADX, Trend) │
└────────┬──────────┘
         │
    ┌────┴────┬────────────┐
    ▼         ▼            ▼
┌───────┐ ┌───────┐ ┌───────────┐
│Cycle  │ │Hour   │ │Box Range  │
│Rider  │ │Swing  │ │Detection  │
│Scan   │ │Scan   │ │& Scan     │
└───┬───┘ └───┬───┘ └─────┬─────┘
    │         │           │
    ▼         ▼           ▼
┌───────────────────────────────┐
│      Signal Queue Service     │
│  (Priority: CycleRider > Box) │
└───────────────┬───────────────┘
                │
                ▼
┌───────────────────────────────┐
│     Risk Manager Check        │
│  - Max positions              │
│  - Same direction limit       │
│  - Cooldown check             │
│  - Daily P&L limit            │
└───────────────┬───────────────┘
                │
                ▼
        [Queue Active Signals]
```

### 5.2 Entry Execution (Every 1 minute)

```
┌─────────────────────────────────────────────────────────────────┐
│                    1-Minute Entry Check Flow                     │
└─────────────────────────────────────────────────────────────────┘

[Every 1 minute] Cron Trigger
        │
        ▼
┌───────────────────┐
│ Get Active        │
│ Signals from Queue│
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│ For Each Signal:  │
│ Check 1m Entry    │
│ Conditions        │
└────────┬──────────┘
         │
    ┌────┴────────────────┐
    │                     │
    ▼                     ▼
[Conditions Met]    [Conditions NOT Met]
    │                     │
    ▼                     ▼
┌───────────────┐   [Continue Waiting]
│ Order Executor│   (Max wait: signal expiry)
│ - Place Entry │
│ - Set SL/TP   │
└───────┬───────┘
        │
        ▼
┌───────────────────┐
│ User Data Stream  │
│ Monitors Fill     │
└───────────────────┘
```

### 5.3 Position Management

```
┌─────────────────────────────────────────────────────────────────┐
│                   Position Management Flow                       │
└─────────────────────────────────────────────────────────────────┘

[Order Filled Event]
        │
        ▼
┌───────────────────┐
│ Create Position   │
│ Record in DB      │
└────────┬──────────┘
         │
         ▼
┌───────────────────────────────────────┐
│         Position Manager Loop          │
│         (Every 10 seconds)             │
└────────────────┬──────────────────────┘
                 │
    ┌────────────┼────────────┬──────────────┐
    ▼            ▼            ▼              ▼
[Check      [Check        [Check         [Check
 TP1 Hit]    TP2 Hit]      SL Hit]        Time Exit]
    │            │            │              │
    ▼            ▼            ▼              ▼
┌─────────┐ ┌─────────┐ ┌─────────┐   ┌─────────┐
│Close 25%│ │Close    │ │Close    │   │Close if │
│~70%     │ │Remaining│ │All      │   │Max Time │
│         │ │         │ │         │   │Exceeded │
│Activate │ │Record   │ │Record   │   │         │
│Trailing │ │PnL      │ │Loss     │   │         │
└─────────┘ └─────────┘ └─────────┘   └─────────┘
```

### 5.4 User Data Stream Events

```
┌─────────────────────────────────────────────────────────────────┐
│                User Data Stream Event Handling                   │
└─────────────────────────────────────────────────────────────────┘

[Binance WebSocket] ORDER_TRADE_UPDATE
        │
        ▼
┌───────────────────┐
│ Parse Event:      │
│ - Symbol          │
│ - Side            │
│ - Order Type      │
│ - Execution Type  │
│ - Realized PnL    │
│ - Order ID        │
└────────┬──────────┘
         │
    ┌────┴────────────────┬─────────────────┐
    ▼                     ▼                 ▼
[Entry Order]      [TP Order]        [SL Order]
    │                     │                 │
    ▼                     ▼                 ▼
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│Match Signal │   │Match by     │   │Match by     │
│by ClientID  │   │TP Order ID  │   │SL Order ID  │
│             │   │             │   │             │
│Create       │   │Record       │   │Record       │
│Position     │   │Partial PnL  │   │Loss         │
│             │   │             │   │             │
│Place SL/TP  │   │Update       │   │Close        │
│Orders       │   │Position     │   │Position     │
└─────────────┘   └─────────────┘   └─────────────┘
```

---

## 6. Risk Management

### 6.1 Position Limits

| Strategy | Max Positions | Max Same Direction |
|----------|---------------|-------------------|
| Cycle Rider | 5 | 3 |
| Hour Swing | 3 | 2 |
| Box Range | 4 | 1 |

### 6.2 Daily P&L Limits

| Parameter | Value |
|-----------|-------|
| Max Daily Loss | -$100 (configurable) |
| Action | Stop all new entries |

### 6.3 Cooldown Mechanisms

| Trigger | Cooldown |
|---------|----------|
| Cycle Rider SL | 30 minutes |
| Hour Swing SL | 15 minutes |
| Hour Swing 3x SL streak | 60 minutes (Kill Switch) |
| Box Range SL | 15 minutes |
| Box Range 2x same-box SL | 120 minutes |

### 6.4 Concurrent Entry Protection

| Strategy | Window | Max Entries |
|----------|--------|-------------|
| Hour Swing | 5 minutes | 2 |

### 6.5 Time-Based Protection

| Time (KST) | Affected Strategy | Action |
|------------|-------------------|--------|
| 22:00~00:30 | Box Range | Blocked |

---

## 7. Performance Metrics

### 7.1 Recent Performance (Jan 22-24, 2026)

| Metric | Value |
|--------|-------|
| Total Trades | 5 |
| Win Rate | 40% |
| Total PnL | +$7.57 |
| Avg Win | $12.11 |
| Avg Loss | $5.55 |
| Profit Factor | 1.46 |
| R:R Ratio | 2.18 |

### 7.2 Strategy Performance

| Strategy | Trades | Win Rate | PnL |
|----------|--------|----------|-----|
| Cycle Rider | 4 | 50% | +$9.69 |
| Hour Swing | 1 | 0% | -$2.12 |
| Box Range | 0 | - | - |

### 7.3 Trade Log

| Date | Symbol | Strategy | Direction | PnL | Result |
|------|--------|----------|-----------|-----|--------|
| 1/22 | FRAXUSDT | Cycle Rider | SHORT | +$23.78 | TP1+TP2 |
| 1/22 | MANAUSDT | Cycle Rider | SHORT | -$7.57 | SL |
| 1/24 | ICPUSDT | Cycle Rider | LONG | +$0.43 | Manual |
| 1/24 | HYPEUSDT | Cycle Rider | SHORT | -$6.95 | SL |
| 1/24 | UNIUSDT | Hour Swing | LONG | -$2.12 | SL |

---

## Appendix A: Configuration Files

| File | Location |
|------|----------|
| Cycle Rider | `backend/src/dual-strategy/constants/cycle-rider.config.ts` |
| Hour Swing | `backend/src/dual-strategy/constants/hour-swing.config.ts` |
| Box Range | `backend/src/dual-strategy/constants/box-range.config.ts` |
| Common | `backend/src/dual-strategy/constants/common.config.ts` |

## Appendix B: Entity Models

| Entity | Description |
|--------|-------------|
| Trade | Trade records with PnL |
| Position | Active position tracking |
| Signal | Generated signals |
| DailyPerformance | Daily performance summary |
| StrategyLog | Strategy execution logs |
| RiskEvent | Risk management events |

---

*Document auto-generated from system configuration*
