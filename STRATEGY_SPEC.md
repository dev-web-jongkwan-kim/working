# Trading Strategy Specification

현재 사용 중인 자동 트레이딩 전략 상세 명세서

---

## 목차

1. [전략 개요](#전략-개요)
2. [Core Trend Strategy](#core-trend-strategy)
3. [Squeeze Strategy](#squeeze-strategy)
4. [Funding Overlay](#funding-overlay)
5. [리스크 관리](#리스크-관리)
6. [실시간 매매 동작 흐름](#실시간-매매-동작-흐름)

---

## 전략 개요

| 전략 | 타입 | Signal TF | Entry TF | 특징 |
|------|------|-----------|----------|------|
| **Core Trend** | 추세 추종 | 1D | 4H | EMA 크로스 + 풀백 진입 |
| **Squeeze** | 변동성 확장 | 1H | 15m | BB 압축 → 브레이크아웃 |

### 공통 설정

| 항목 | 값 |
|------|-----|
| Risk per Trade | 0.5% of equity |
| Daily Loss Limit | 1% of equity |
| Max Positions | 3개 (전략당) |
| Base Leverage | 10x |
| Commission Rate | 0.05% (진입+청산 = 0.1%) |

---

## Core Trend Strategy

> Multi-timeframe 추세 추종 전략. 1D에서 추세 방향을 확인하고, 4H에서 풀백/브레이크아웃 진입.

### 진입 조건

#### 1단계: 1D 추세 확인

| 조건 | 파라미터 |
|------|----------|
| EMA Fast | 50일 |
| EMA Slow | 200일 |
| 최소 EMA 분리 | 0.5% |
| ADX 최소값 | 30 (강한 추세) |

**추세 판단:**
- `EMA50 > EMA200` → **LONG**
- `EMA50 < EMA200` → **SHORT**

#### 2단계: 4H 진입 트리거

| 진입 타입 | 조건 |
|-----------|------|
| **PULLBACK_REVERSAL** | 가격이 EMA20 1ATR 이내 + 반전 캔들 확인 |
| **BREAKOUT_REENTRY** | 최근 10봉 고/저점 돌파 + 이전봉 고/저점 초과 종가 |

**진입 품질:**
- `HIGH`: 풀백 깊이 ≤ 0.5 ATR
- `MEDIUM`: 풀백 깊이 ≤ 1.0 ATR 또는 브레이크아웃

### 청산 조건

| 구분 | 값 | 설명 |
|------|-----|------|
| **Initial SL** | 2.0 ATR | 4H ATR 기준 |
| **TP1** | 1R (1:1) | 리스크 대비 1배 수익 |
| **TP1 수량** | 30% | 포지션의 30% 청산 |
| **Trailing Stop** | 2.5 ATR | TP1 이후 활성화 |
| **Time Stop** | 30 × 4H = 120시간 | 최대 5일 홀딩 |

### 청산 흐름

```
진입 → [SL 2.0 ATR 설정]
    ↓
TP1 도달 (1R)
    ├→ 30% 청산 (수익 확보)
    ├→ SL → Breakeven 이동
    └→ Trailing Stop 활성화 (2.5 ATR)
    ↓
[이후 시나리오]
    ├→ Trailing Stop 히트 → 잔여 70% 청산
    ├→ Time Stop (120시간) → 전량 청산
    └→ 원래 SL 히트 (TP1 전) → 전량 손절
```

### Configuration

```typescript
{
  timeframes: { signal: '1d', entry: '4h' },
  trend: {
    emaFast1d: 50,
    emaSlow1d: 200,
    minEmaSeparationPct: 0.5,
  },
  entry: {
    atrLen4h: 14,
    pullbackAtrMult: 1.0,
    useLimitEntry: true,
    limitTimeoutSec: 20,
  },
  exit: {
    slAtrMult: 2.0,
    tp1R: 1.0,
    tp1QtyPct: 0.3,
    trailAtrMult: 2.5,
    timeStopBars4h: 30,
  },
  position: {
    leverage: 10,
    marginUsd: 50,
    cooldownBars: 4,
  },
}
```

---

## Squeeze Strategy

> 변동성 압축 후 폭발적인 브레이크아웃을 포착하는 전략. 1H에서 BB 압축을 감지하고, 15m에서 브레이크아웃 확인.

### 진입 조건

#### 1단계: 1H BB 압축 감지

| 파라미터 | 값 | 설명 |
|----------|-----|------|
| BB Period | 20 | 볼린저밴드 기간 |
| BB StdDev | 2.0 | 표준편차 배수 |
| Lookback | 120봉 | 퍼센타일 계산 범위 |
| Compress Percentile | 15% | 하위 15%면 압축 |
| Min Bars in Compression | 3봉 | 최소 압축 유지 기간 |

**압축 판단:**
```
현재 BBWidth가 최근 120봉 중 하위 15% 이하
+ 최소 3봉 이상 압축 상태 유지
```

#### 2단계: 15m 브레이크아웃 확인

| 조건 | 설명 |
|------|------|
| **종가 돌파** | 종가가 압축 박스 상단/하단 돌파 (wick 아님) |
| **볼륨 확인** | 현재 볼륨 / 20봉 평균 볼륨 |
| **모멘텀 확인** | 캔들 바디 / 캔들 레인지 비율 |

**브레이크아웃 품질:**

| 등급 | 볼륨 배율 | 바디 비율 |
|------|-----------|-----------|
| **HIGH** | ≥ 1.5x | ≥ 60% |
| **MEDIUM** | ≥ 1.0x | ≥ 40% |
| **LOW** | < 1.0x | < 40% |

### 청산 조건

| 구분 | 값 | 설명 |
|------|-----|------|
| **Initial SL** | Box Edge + 0.2 ATR | 압축 박스 반대편 + 버퍼 |
| **TP1** | 1R (1:1) | 리스크 대비 1배 수익 |
| **TP1 수량** | 25% | 포지션의 25% 청산 |
| **Trailing Stop** | 2.2 ATR | TP1 이후 활성화 |
| **Time Stop** | 없음 | Trailing으로만 청산 |

### 청산 흐름

```
진입 → [SL = Box Edge + 0.2 ATR]
    ↓
TP1 도달 (1R)
    ├→ 25% 청산
    ├→ SL → Breakeven
    └→ Trailing Stop 활성화 (2.2 ATR)
    ↓
[이후 시나리오]
    ├→ Trailing Stop 히트 → 잔여 75% 청산
    └→ 원래 SL 히트 (TP1 전) → 전량 손절
```

### Configuration

```typescript
{
  timeframes: { detect: '1h', entry: '15m' },
  compression: {
    bbLen1h: 20,
    bbK1h: 2.0,
    compressLookback1h: 120,
    compressPercentile: 0.15,
    minBarsInCompression: 3,
  },
  breakout: {
    breakoutLookback15m: 32,
    requireCloseBreak: true,
    retestMode: 'optional',
    retestTimeoutBars: 8,
  },
  exit: {
    atrLen1h: 14,
    slStructureBufferAtrMult: 0.2,
    tp1R: 1.0,
    tp1QtyPct: 0.25,
    trailAtrMult: 2.2,
  },
  position: {
    leverage: 10,
    marginUsd: 50,
    cooldownBars: 4,
  },
}
```

---

## Funding Overlay

> 펀딩비 기반 오버레이. 극단적인 펀딩비 상황에서 포지션 조정.

### 동작 원리

| 펀딩비 상태 | LONG 진입 시 | SHORT 진입 시 |
|-------------|--------------|---------------|
| **HIGH (≥90 pctl)** | TIGHTEN/BLOCK | ALLOW (유리) |
| **LOW (≤10 pctl)** | ALLOW (유리) | TIGHTEN/BLOCK |
| **NORMAL** | ALLOW | ALLOW |

### 액션 유형

| 액션 | 설명 | 조정 내용 |
|------|------|-----------|
| **ALLOW** | 정상 진입 | 변경 없음 |
| **TIGHTEN** | 조기 이익실현 | TP1 수량 +10%, Trail -0.3 ATR |
| **BLOCK** | 진입 거부 | 시그널 무시 |

### Configuration

```typescript
{
  enabled: true,
  lookbackSamples: 200,
  highPctl: 0.9,       // 90퍼센타일
  lowPctl: 0.1,        // 10퍼센타일
  onExtreme: 'tighten', // 'block' 또는 'tighten'
  tighten: {
    tp1QtyPctAdd: 0.1,    // +10%
    trailAtrMultSub: 0.3, // -0.3 ATR
  },
}
```

### TIGHTEN 적용 예시

| 항목 | 원래 값 | TIGHTEN 후 |
|------|---------|------------|
| Core Trend TP1 수량 | 30% | 40% |
| Core Trend Trail ATR | 2.5 | 2.2 |
| Squeeze TP1 수량 | 25% | 35% |
| Squeeze Trail ATR | 2.2 | 1.9 |

---

## 리스크 관리

### Position Sizing (변동성 기반)

```
risk_usd = equity × 0.5%
stop_distance = ATR × SL_ATR_MULT
position_size = risk_usd / (stop_distance / entry_price)
```

**예시:**
```
Equity: $10,000
Risk per trade: $50 (0.5%)
Entry: $100
ATR: $2
SL ATR Mult: 2.0
Stop Distance: $4 (4%)

Position Size = $50 / 0.04 = $1,250
Quantity = 12.5 units
```

### Daily Loss Limit (Kill Switch)

| 파라미터 | 값 |
|----------|-----|
| 일일 손실 한도 | 1% of starting equity |
| 리셋 시간 | UTC 00:00 |
| 쿨다운 | 4시간 |

**동작:**
```
일일 실현손실 ≥ 1% → Kill Switch 활성화
    ↓
신규 진입 차단 (4시간 또는 다음날까지)
기존 포지션은 유지 (정상 청산)
```

### Correlation 조정

```
같은 방향 포지션 수 증가 → 신규 포지션 사이즈 감소
최대 50%까지 감소
```

---

## 실시간 매매 동작 흐름

### 전체 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    Data Collection Layer                     │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  Binance WS  │  Candle Cache│ Funding Rate │ User Data Stream│
│  (실시간가격) │   (OHLCV)    │   (8시간)    │  (주문/체결)    │
└──────┬───────┴──────┬───────┴──────┬───────┴───────┬────────┘
       │              │              │               │
       ▼              ▼              ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Strategy Engine                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐  │
│  │ Core Trend  │    │   Squeeze   │    │ Funding Overlay │  │
│  │  Strategy   │    │  Strategy   │    │   (Modifier)    │  │
│  └──────┬──────┘    └──────┬──────┘    └────────┬────────┘  │
│         │                  │                     │           │
│         └────────┬─────────┘                     │           │
│                  ▼                               │           │
│         ┌───────────────┐                        │           │
│         │ Signal Check  │◄───────────────────────┘           │
│         └───────┬───────┘                                    │
│                 │                                            │
└─────────────────┼────────────────────────────────────────────┘
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    Risk Management                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Kill Switch │  │  Position   │  │ Exposure Limiter    │  │
│  │ (Daily 1%)  │  │   Sizing    │  │ (Max 3 per strategy)│  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    Execution Layer                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ Live Executor   │    │ Position Manager                │ │
│  │ - Market Order  │    │ - 10초마다 모니터링              │ │
│  │ - SL/TP Order   │    │ - Trailing Stop 업데이트        │ │
│  │ - Partial Close │    │ - P&L 계산                      │ │
│  └─────────────────┘    └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 시그널 생성 주기

| 전략 | 체크 주기 | 설명 |
|------|-----------|------|
| Core Trend | 4H 캔들 종가 | 4시간마다 새 캔들 확인 |
| Squeeze | 15m 캔들 종가 | 15분마다 브레이크아웃 확인 |

### 진입 프로세스

```
1. 캔들 종가 업데이트 (Data Collector)
       ↓
2. 시그널 생성 (Strategy Engine)
   - Core Trend: 1D 추세 + 4H 진입 조건
   - Squeeze: 1H 압축 + 15m 브레이크아웃
       ↓
3. Funding Overlay 적용
   - BLOCK → 진입 취소
   - TIGHTEN → 파라미터 조정
   - ALLOW → 원래 파라미터
       ↓
4. 리스크 체크
   - Kill Switch 확인
   - Max Positions 확인
   - Position Size 계산
       ↓
5. 주문 실행 (Live Executor)
   - Market Order (진입)
   - SL Order (STOP_MARKET)
   - TP Order (TAKE_PROFIT_MARKET) - 선택적
       ↓
6. DB 저장 + WebSocket 알림
```

### 포지션 모니터링 (10초 주기)

```
매 10초마다:
   │
   ├→ 현재가 조회
   │
   ├→ 미실현 P&L 계산
   │   pnl = (현재가 - 진입가) / 진입가 × 레버리지 × 마진
   │   (숏은 반대)
   │
   ├→ Trailing Stop 업데이트 (TP1 이후)
   │   LONG: newTrail = 현재가 - (ATR × TrailMult)
   │         if newTrail > 기존Trail → 업데이트
   │   SHORT: 반대
   │
   ├→ Trailing Stop 히트 체크
   │   LONG: 현재가 ≤ TrailingStop → 청산
   │   SHORT: 현재가 ≥ TrailingStop → 청산
   │
   └→ WebSocket으로 프론트엔드 업데이트
```

### SL/TP 체결 처리 (UserDataStream)

```
바이낸스 WebSocket (User Data Stream)
       │
       ▼
주문 체결 이벤트 수신
       │
       ├→ SL 체결
       │   - Position CLOSED
       │   - 손실 기록
       │   - Kill Switch 업데이트
       │
       ├→ TP1 체결 (일부 청산)
       │   - 30%/25% 청산 완료
       │   - 잔여 포지션 업데이트
       │   - SL → Breakeven 이동
       │   - Trailing Stop 활성화
       │
       └→ 전량 청산
           - Position CLOSED
           - 최종 P&L 계산
           - DB 업데이트
```

### 비용 계산

| 항목 | 비율 | 예시 ($1000 포지션) |
|------|------|---------------------|
| 진입 수수료 | 0.05% | $0.50 |
| 청산 수수료 | 0.05% | $0.50 |
| **총 수수료** | **0.10%** | **$1.00** |
| 펀딩비 (8시간당) | ~0.01% | ~$0.10 |

**P&L 계산:**
```
Gross PnL = (Exit - Entry) / Entry × Position Size
Net PnL = Gross PnL - Commission - Funding Cost
```

---

## 전략별 예상 특성

| 지표 | Core Trend | Squeeze |
|------|------------|---------|
| 평균 홀딩 기간 | 1-5일 | 1-24시간 |
| 예상 승률 | 40-50% | 45-55% |
| 평균 RR | 1.5-2.5 | 1.2-2.0 |
| 신호 빈도 | 낮음 | 중간 |
| 최적 시장 | 추세장 | 횡보 후 돌파 |

---

## 모니터링 항목

### 실시간 대시보드

- 활성 포지션 수
- 미실현 P&L
- 일일 실현 P&L
- Kill Switch 상태
- 최근 시그널 로그

### 알림 조건

| 이벤트 | 알림 |
|--------|------|
| 신규 진입 | WebSocket + DB Log |
| TP1 히트 | WebSocket + DB Log |
| SL 히트 | WebSocket + DB Log |
| Kill Switch 발동 | WebSocket + DB Log |
| 에러 발생 | Logger + Slack (선택) |

---

*Last Updated: 2025-01-30*
