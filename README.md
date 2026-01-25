# Dual Strategy Trading System

자동화된 암호화폐 선물 트레이딩 시스템 (Binance Futures)

## 전략 구성

### 1. Cycle Rider (Strategy A)
- **목표**: 추세 사이클 전체 포착
- **서브전략**: Accumulation, Distribution, Divergence, Volume Climax, Squeeze
- **레버리지**: 15x, 마진: $50

### 2. Hour Swing (Strategy B)
- **목표**: 1시간봉 기반 단기 스윙
- **서브전략**: MTF Alignment, Funding Extremes
- **레버리지**: 10-12x, 마진: $15-30

### 3. Box Range (Strategy C)
- **목표**: 횡보장 박스권 트레이딩
- **진입**: 박스 상하단 Entry Zone에서 반전 매매
- **레버리지**: 12x, 마진: $20

### 4. Lottery (Flash Crash Hunting)
- **목표**: 급락 시 저점 매수
- **방식**: 현재가 대비 15-30% 하락 지정가 주문

---

## 최근 변경사항 (2026-01-25)

### Box Range 필터 완화
진입 기회 확대를 위해 보수적 필터 완화:

| 파라미터 | 변경 전 | 변경 후 | 설명 |
|----------|---------|---------|------|
| maxConsecutiveBars | 2 | 3 | 연속봉 제한 완화 |
| maxVolumeRatio | 0.85 | 2.3 | 볼륨 증가 허용 (130%까지) |
| entryZonePercent | 0.20 | 0.25 | 진입존 확대 (20%→25%) |

### Lottery Binance 동기화 기능 추가
- DB-Binance 주문 상태 동기화 엔드포인트 추가
- PENDING 상태 주문 검증 및 자동 정리
- `POST /api/lottery/sync`

### Frontend 포트 설정 수정
- API 연결 포트: 3001 → 4040
- WebSocket 연결 포트: 3001 → 4040

---

## 설정 파일 위치

```
backend/src/dual-strategy/constants/
├── cycle-rider.config.ts   # Cycle Rider 설정
├── hour-swing.config.ts    # Hour Swing 설정
└── box-range.config.ts     # Box Range 설정
```

---

## 실행 방법

### Backend
```bash
cd backend
npm run start:dev
# 포트: 4040
```

### Frontend
```bash
cd frontend
npm run dev
# 포트: 4041
```

---

## API 엔드포인트

### System
- `GET /api/system/status` - 시스템 상태 조회
- `POST /api/system/start` - 실시간 매매 시작
- `POST /api/system/stop` - 실시간 매매 중지

### Trades
- `GET /api/trades` - 거래 내역 조회
- `GET /api/positions` - 활성 포지션 조회

### Lottery
- `GET /api/lottery/orders` - 로터리 주문 조회
- `POST /api/lottery/sync` - Binance 동기화

---

## 현재 시장 레짐별 전략 동작

| 레짐 | Cycle Rider | Hour Swing | Box Range |
|------|-------------|------------|-----------|
| STRONG_UPTREND | LONG 위주 | 활성 | 비활성 |
| WEAK_UPTREND | LONG 위주 | 활성 | 제한적 |
| SIDEWAYS | 양방향 | 활성 | **활성** |
| WEAK_DOWNTREND | SHORT 위주 | 활성 | 제한적 |
| STRONG_DOWNTREND | SHORT 위주 | 활성 | 비활성 |

---

## 주요 필터 기준

### Cycle Rider
- ATR: 0.45% ~ 3%
- RSI 필터: 레짐에 따른 역추세 진입 제한
- 연속봉: 최대 3개

### Box Range
- RSI: LONG ≤ 35, SHORT ≥ 65
- Entry Zone: 박스 상하단 25% 이내
- Volume Ratio: ≤ 2.3

---

## 환경 변수

### Backend (.env)
```
BINANCE_API_KEY=your_api_key
BINANCE_SECRET_KEY=your_secret_key
```

### Frontend (.env)
```
NEXT_PUBLIC_API_URL=http://localhost:4040
NEXT_PUBLIC_WS_URL=http://localhost:4040
```
