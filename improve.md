좋아. **5m/15m에 얽매이지 않고 “꾸준함(robustness)”을 최우선**으로 두면, 실전에서 가장 재현성 있게 살아남는 축은 거의 항상 이거야:

* **(코어) 멀티 타임프레임 트렌드 팔로잉/TSMOM + 변동성 타겟(포지션 사이징)**
  크립토에서도 트렌드/모멘텀 계열이 장기적으로 가장 일관되게 관측되는 축이라는 연구들이 있어. ([SSRN][1])
* **(오버레이) 펀딩/캐리(베이시스·펀딩)로 “리스크를 조절”**
  펀딩/캐리 전략은 수익원인 동시에 꼬리리스크가 커서, “방향 맞추기”가 아니라 **거래 강도/허용 여부 스위치**로 쓰는 게 안정적이야. ([국제결제은행][2])
* **(부스터) 인트라데이 모멘텀/돌파는 ‘빈도’ 담당**
  짧은 구간에서도 인트라데이 모멘텀/리버설 패턴이 관측되고, 특정 시간대·유동성 조건에서 강해지는 결과가 있음. ([centaur.reading.ac.uk][3])

아래는 **“지금 당장 시스템을 갈아엎고, 바로 매매 가능한”** 형태로 만든 **최고 우선순위 조합(현실적으로 제일 단단한 버전)**이야.
(단, “바로 부자”는 누구도 보장 못 해. 대신 **안 터지고 오래 버티는 구조 = 장기적으로 부자 확률을 최대화**하는 구조로 간다.)

---

## A. 내가 추천하는 ‘최고 조합’ (단단함 우선)

### 1) 코어 알파: 멀티 타임프레임 트렌드 팔로잉 (4H + 1D)

**왜 이게 코어냐**
5m/15m는 시장 미세구조/비용/노이즈에 너무 민감해서 “꾸준함”이 깨지기 쉬워. 반대로 **4H/1D 트렌드**는 크립토에서 상대적으로 재현성이 높게 보고되는 축이야. ([SSRN][1])

**신호(단순하고 견고하게)**

* 타임프레임: `4H`, `1D`
* 방향: `EMA(1D, 50) vs EMA(1D, 200)` 또는 `12개월/6개월 TSMOM` 스타일(간단 버전)
* 트리거: 4H에서 `돌파/되돌림 재진입`(엔트리 품질 개선)
* 청산: `ATR(4H/1D) 기반 트레일 + 시간 스탑`

**거래 빈도**

* BTC/ETH + 상위 20~50개 유동성 코인까지 넓히면, “항상 매일”은 아니어도 **주당 수십 건 수준**은 확보됨(특히 변동성 장에서).

---

### 2) 빈도 부스터: 압축→확장(스퀴즈) 돌파 (1H + 15m)

**역할**: “매일 몇 건”을 만들고, 트렌드 초입을 잡는 엔진

* 변동성 압축 후 확장 패턴은 크립토에서 자주 나오고, 1H/15m로 올리면 5m보다 비용 내성이 좋아짐.

**신호**

* 압축 탐지(1H): `BBWidth 하위 분위수` 또는 `ATR 하위 분위수`
* 트리거(15m): 박스 상/하단 **종가 확정 돌파** + (옵션) 1회 리테스트
* 청산: 구조적 SL(박스 반대편) + 1R 부분청산 + ATR 트레일

---

### 3) 안정화 오버레이: 펀딩 분위수 스위치 (퍼프 전용)

펀딩은 “예측 신호”로 쓰면 망가지기 쉬운데, **거래 강도/허용을 조절하는 안전장치**로 쓰면 꽤 유용해. 펀딩 역학/캐리 리스크 쪽 연구들도 이 관점이 맞아. ([국제결제은행][2])

**룰(예시)**

* `fund_pctl >= 0.9`(롱 과열)일 때:

    * 신규 롱 진입을 “더 빡세게” (ADX/돌파확정/리테스트 필수)
    * 트레일 촘촘 / 부분청산 빨리
* `fund_pctl <= 0.1`(숏 과열) 대칭

(펀딩 자체 예측 가능성을 다룬 연구도 있으나, 이건 “안전장치”가 더 실전적이야.) ([SSRN][4])

---

## B. “지금 당장 매매 시작”을 위한 운영 룰 (부자되는 쪽은 여기서 갈림)

### 1) 변동성 타겟 사이징(필수)

* 포지션 수량은 **SL 거리(ATR 기반)**로 결정
* `risk_per_trade = equity * 0.25%~0.75%`
* `qty = risk_per_trade / stop_distance`

### 2) 킬스위치(필수)

* `일일 -2R` 또는 `일일 -1%` 도달 시 **그날 신규 진입 금지**

### 3) 노출 제한(필수)

* 동시 포지션 수 제한(예: 5개)
* 동일 방향 과노출 제한(예: 롱 노출 70% 초과 금지)
* BTC 방향이 강할 때 알트 동방향 과다 금지(상관 노출 컷)

---

## C. “전략 상태머신” (AI가 그대로 코드로 옮기기 좋게)

### 공통 상태

* `IDLE` → `SETUP` → `ENTRY_PENDING` → `IN_POSITION` → `SCALE_OUT` → `TRAILING` → `EXITED`
* 공통 이벤트: `BAR_CLOSE(tf)`, `ORDER_FILLED`, `STOP_HIT`, `TP_HIT`, `TIME_STOP`

### 1) 코어 트렌드(4H/1D) 상태머신

* `SETUP`: 1D 방향 확정(EMA50>EMA200 같은)
* `ENTRY_PENDING`: 4H에서 조건 충족(재돌파/되돌림) 시 지정가/시장가 정책 실행
* `IN_POSITION`: SL/TP(부분청산) 등록
* `SCALE_OUT`: 1R에서 25~40% 청산
* `TRAILING`: ATR 트레일로 나머지 관리
* `EXITED`: 트레일/시간스탑/반대신호 시 종료 + 쿨다운

### 2) 스퀴즈(1H/15m) 상태머신

* `SETUP`: 1H 압축 감지(BBWidth 하위 분위수)
* `ENTRY_PENDING`: 15m 종가 돌파 확인 → (옵션) 리테스트 기다림
* 나머지는 동일(부분청산+트레일)

### 3) 펀딩 오버레이 상태

* 각 엔트리 직전에 `ALLOW / TIGHTEN / BLOCK` 반환

    * `BLOCK`: 거래 금지(예: 과열+불리한 레짐)
    * `TIGHTEN`: SL/트레일/부분청산을 보수적으로 변경
    * `ALLOW`: 기본값

---

## D. 백테스트/리포트 템플릿 (이거 안 하면 무조건 망가짐)

### 필수 비용 포함

* maker/taker fee
* 슬리피지(bps)
* 펀딩(보유 시간에 따라)

### 리포트(필수 표)

1. 전체 성과: CAGR(참고), MDD, Sharpe/Sortino, PF, 승률, 평균 R, 기대값
2. **레짐별 성과 분해**: TREND vs COMPRESSION
3. 심볼별 성과/기여도: 상위/하위 10개 심볼
4. 시간대별 성과(UTC 기준): 특정 시간대에만 망가지면 즉시 차단
5. 거래비용 영향: gross vs net 비교(수수료/슬리피지가 엣지를 먹는지 확인)

(인트라데이 예측 가능성이 “점프/유동성/이벤트”에 따라 바뀐다는 결과들도 있어서, 시간대/이벤트 민감도 체크가 특히 중요해.) ([IDEAS/RePEc][5])

---

## E. 유니버스 자동 선정(매우 중요)

* 필터: 24h 거래대금(quote volume), 스프레드(bps), 최소주문수량/스텝사이즈
* 스프레드: top-of-book 샘플링 → 최근 평균이 기준 이하만 채택
* 결과물: `universe.json` (거래소별 심볼 매핑 포함)

---

## F. 구현용 설정 파일(권장 기본값)

(파라미터는 “견고함” 위주 초기값이고, 최적화는 최소화)

```yaml
timeframes:
  core_trend:
    signal_tf: "1D"
    entry_tf: "4H"
  squeeze:
    detect_tf: "1H"
    entry_tf: "15m"

risk:
  risk_pct_per_trade: 0.005
  daily_loss_limit_pct: 0.01
  max_open_positions_total: 5
  max_same_direction_exposure: 0.7
  cooldown_bars_entry_tf: 4

fees:
  maker_bps: 2
  taker_bps: 5
slippage:
  market_bps: 5
  limit_bps: 1
  limit_timeout_sec: 20

core_trend:
  ema_fast_1d: 50
  ema_slow_1d: 200
  atr_len_4h: 14
  sl_atr_mult: 2.0
  tp1_R: 1.0
  tp1_qty_pct: 0.3
  trail_atr_mult: 2.5
  time_stop_bars_4h: 30

squeeze:
  bb_len_1h: 20
  bb_k_1h: 2.0
  compress_lookback_1h: 120
  compress_percentile: 0.15
  breakout_lookback_15m: 32
  require_close_break: true
  retest_mode: "optional"  # off|optional|required
  atr_len_1h: 14
  sl_structure_buffer_atr_mult: 0.2
  tp1_R: 1.0
  tp1_qty_pct: 0.25
  trail_atr_mult: 2.2

funding_overlay:
  enabled: true
  lookback_samples: 200
  high_pctl: 0.9
  low_pctl: 0.1
  on_extreme:
    action: "tighten"  # block|tighten
    tighten:
      tp1_qty_pct_add: 0.1
      trail_atr_mult_sub: 0.3
```

---

## G. “지금 당장” 실행 플로우 (실전형)

1. **LIVE에서도 무조건 “킬스위치+노출제한+SL 서버등록”부터 켠다**
2. 코어 트렌드 + 스퀴즈 **두 전략만** 켠다(옵션 전략/스캘핑 금지)
3. 펀딩 오버레이는 **block보단 tighten부터**(너무 막으면 기회 상실)
4. 유니버스는 “유동성/스프레드” 최우선으로 자동 갱신
5. 매일 리포트에서 **비용이 엣지를 먹는지**를 먼저 본다(이게 제일 흔한 실패 원인)

---

## H. 마지막으로: “최고의 전략” 한 줄로 요약하면

**크립토에서 ‘꾸준함’에 가장 가까운 건, 멀티 타임프레임 트렌드(Managed-futures 스타일) + 변동성 타겟 + 펀딩 오버레이 + (필요할 때만) 인트라데이 돌파로 빈도 보강**이야. ([SSRN][1])

---

원하면 내가 여기서 더 밀어붙여서, **네 현재 시스템 스택(Node/TS/파이프라인/DB/백테스터 유무)**을 “가정”하고도 바로 개발 착수할 수 있게:

* **인터페이스(함수 시그니처)**
* **포지션/주문 동기화 로직**
* **거래소별(Binance/OKX) 주문 타입 매핑**
  까지 “코드 설계 문서” 형태로 한 번에 내려줄 수도 있어.

[1]: https://papers.ssrn.com/sol3/Delivery.cfm/4551518.pdf?abstractid=4551518&mirid=1&utm_source=chatgpt.com "Trend-following Strategies for Crypto Investors Trinh Le* ..."
[2]: https://www.bis.org/publ/work1087.pdf?utm_source=chatgpt.com "Crypto carry"
[3]: https://centaur.reading.ac.uk/100181/3/21Sep2021Bitcoin%20Intraday%20Time-Series%20Momentum.R2.pdf?utm_source=chatgpt.com "Bitcoin intraday time-series momentum - CentAUR"
[4]: https://papers.ssrn.com/sol3/Delivery.cfm/fe1e91db-33b4-40b5-9564-38425a2495fc-MECA.pdf?abstractid=5576424&mirid=1&utm_source=chatgpt.com "Predictability of Funding Rates"
[5]: https://ideas.repec.org/a/eee/ecofin/v62y2022ics1062940822000833.html?utm_source=chatgpt.com "Intraday return predictability in the cryptocurrency markets"
