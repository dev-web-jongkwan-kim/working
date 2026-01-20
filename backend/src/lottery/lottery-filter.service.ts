import { Injectable, Logger } from '@nestjs/common';
import { BinanceService } from '../dual-strategy/services/data/binance.service';

interface LotteryCandidate {
  symbol: string;
  score: number;
  signals: {
    funding_rate: number;
    funding_level: 'EXTREME' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM';
    change_4h: number;
    momentum: 'EXTREME' | 'VERY_STRONG' | 'STRONG' | 'MEDIUM' | 'WEAK';
    oi_change: number;
    oi_level: 'SURGE' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM';
    rsi: number;
    rsi_level: 'EXTREME' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'WEAK';
    volume_ratio?: number;
    volume_spike?: boolean;
    btc_change_1h?: number;
    btc_dropping?: boolean;
    volatility_24h?: number;
    high_volatility?: boolean;
  };
  timestamp: number;
}

@Injectable()
export class LotteryFilterService {
  private readonly logger = new Logger(LotteryFilterService.name);

  constructor(
    private readonly binanceService: BinanceService,
  ) {}

  /**
   * Filter Top 100 symbols by lottery conditions
   */
  async filterCandidates(symbols: string[]): Promise<LotteryCandidate[]> {
    const candidates: LotteryCandidate[] = [];

    // Process in chunks (rate limit protection)
    const chunks = this.chunkArray(symbols, 20);

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(symbol => this.evaluateSymbol(symbol))
      );

      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          candidates.push(result.value);
        } else if (result.status === 'rejected') {
          this.logger.warn(`Failed to evaluate ${chunk[idx]}: ${result.reason}`);
        }
      });

      // Rate limit protection
      await this.sleep(100);
    }

    this.logger.log(`Filtered ${candidates.length} candidates from ${symbols.length} symbols`);

    return candidates;
  }

  /**
   * Evaluate individual symbol (심플 필터)
   * 1. 레버리지 >= 50
   * 2. 24시간 거래량 > $100M
   * 3. 24시간 변동성 > 5%
   */
  private async evaluateSymbol(symbol: string): Promise<LotteryCandidate | null> {
    try {
      // Fetch minimal data
      const [ticker, klines7d] = await Promise.all([
        this.binanceService.get24hrTicker(symbol),
        this.binanceService.getKlines(symbol, '1d', 7), // 7일 캔들 (급등 알트 판별용)
      ]);

      // 1. 레버리지 체크 생략 (대부분 코인이 50 이상)
      // 선물 거래 가능한 코인은 대부분 레버리지 50 이상
      const maxLeverage = 50; // 가정

      // 2. 24시간 거래량 체크 ($100M)
      const volume24h = parseFloat(ticker.quoteVolume);
      if (volume24h < 100_000_000) return null;

      // 3. 24시간 변동성 체크 (5%)
      const high = parseFloat(ticker.highPrice);
      const low = parseFloat(ticker.lowPrice);
      const volatility24h = (high - low) / low;
      if (volatility24h < 0.05) return null;

      // === 추가 데이터 수집 (스코어링용) ===

      // 7일 상승률 (급등 알트 판별)
      const price7dAgo = parseFloat(klines7d[0].close);
      const priceNow = parseFloat(ticker.lastPrice);
      const change7d = (priceNow - price7dAgo) / price7dAgo;

      // 펀딩 레이트 (급등 알트 판별)
      let fundingRate = 0;
      try {
        fundingRate = await this.binanceService.getFundingRate(symbol);
      } catch (e) {
        // 펀딩 못가져와도 OK
      }

      // === 코인 타입 판별 ===
      let coinType: 'MAJOR' | 'TOP10' | 'PUMPING' | 'OTHERS' = 'OTHERS';

      // 대장주 (BTC, ETH)
      if (symbol === 'BTCUSDT' || symbol === 'ETHUSDT') {
        coinType = 'MAJOR';
      }
      // 메이저 Top 10
      else if (['BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT'].includes(symbol)) {
        coinType = 'TOP10';
      }
      // 급등 알트 (7일 +50% 또는 펀딩 > 0.1%)
      else if (change7d > 0.5 || fundingRate > 0.001) {
        coinType = 'PUMPING';
      }

      // 간단한 메타데이터만 저장
      const signals: any = {
        funding_rate: fundingRate,
        change_7d: change7d,
        volatility_24h: volatility24h,
        volume_24h: volume24h,
        max_leverage: maxLeverage,
        coin_type: coinType,
        funding_level: 'N/A',
        momentum: 'N/A',
        oi_level: 'N/A',
        rsi_level: 'N/A',
        rsi: 0,
        change_4h: 0,
        oi_change: 0,
      };

      // Score는 이제 의미 없지만 인터페이스 유지
      const score = 100;

      return {
        symbol,
        score,
        signals,
        timestamp: Date.now()
      };

    } catch (error) {
      this.logger.warn(`Failed to evaluate ${symbol}: ${error.message}`);
      return null;
    }
  }

  /**
   * Calculate RSI from klines
   */
  private calculateRSI(klines: any[]): number {
    if (klines.length < 2) return 50;

    const changes = [];
    for (let i = 1; i < klines.length; i++) {
      const change = parseFloat(klines[i].close) - parseFloat(klines[i - 1].close);
      changes.push(change);
    }

    const gains = changes.filter(c => c > 0);
    const losses = changes.filter(c => c < 0).map(c => Math.abs(c));

    const avgGain = gains.length > 0
      ? gains.reduce((a, b) => a + b, 0) / changes.length
      : 0;
    const avgLoss = losses.length > 0
      ? losses.reduce((a, b) => a + b, 0) / changes.length
      : 0;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Split array into chunks
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
