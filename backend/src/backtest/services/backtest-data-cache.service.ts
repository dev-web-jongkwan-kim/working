import { Injectable } from '@nestjs/common';
import { Candle } from './binance-data-downloader.service';

/**
 * 백테스트용 데이터 캐시 서비스
 * 기존 DataCacheService와 동일한 인터페이스 제공
 */
@Injectable()
export class BacktestDataCacheService {
  private candles: Map<string, Candle[]> = new Map();
  private currentPrices: Map<string, number> = new Map();
  private fundingRates: Map<string, number> = new Map();
  private currentIndex: Map<string, number> = new Map();
  private currentTime: number = 0;

  /**
   * 백테스트 데이터 초기화
   */
  initialize(candlesBySymbolTimeframe: Map<string, Candle[]>) {
    this.candles = candlesBySymbolTimeframe;
    this.currentIndex.clear();
    this.currentPrices.clear();

    // Initialize indices
    for (const key of this.candles.keys()) {
      this.currentIndex.set(key, 0);
    }
  }

  /**
   * 현재 시간 설정 및 캔들 인덱스 업데이트
   */
  setCurrentTime(timestamp: number) {
    this.currentTime = timestamp;

    // Update indices for all symbol/timeframe pairs
    for (const [key, candles] of this.candles.entries()) {
      let idx = this.currentIndex.get(key) || 0;
      while (idx < candles.length && candles[idx].closeTime <= timestamp) {
        idx++;
      }
      this.currentIndex.set(key, Math.max(0, idx - 1));

      // Update current price from the latest candle
      const [symbol] = key.split('_');
      if (idx > 0) {
        this.currentPrices.set(symbol, candles[idx - 1].close);
      }
    }
  }

  /**
   * 현재 시간 기준으로 최근 N개 캔들 반환
   */
  getRecentCandles(symbol: string, timeframe: string, count: number): Candle[] {
    const key = `${symbol}_${timeframe}`;
    const candles = this.candles.get(key);
    if (!candles) return [];

    const currentIdx = this.currentIndex.get(key) || 0;
    const startIdx = Math.max(0, currentIdx - count + 1);
    return candles.slice(startIdx, currentIdx + 1);
  }

  /**
   * 현재가 반환
   */
  getCurrentPrice(symbol: string): number | null {
    return this.currentPrices.get(symbol) || null;
  }

  /**
   * 현재가 설정
   */
  setCurrentPrice(symbol: string, price: number) {
    this.currentPrices.set(symbol, price);
  }

  /**
   * 펀딩율 반환 (백테스트에서는 기본값 사용)
   */
  getFundingRate(symbol: string): number {
    return this.fundingRates.get(symbol) || 0;
  }

  /**
   * 펀딩율 설정
   */
  setFundingRate(symbol: string, rate: number) {
    this.fundingRates.set(symbol, rate);
  }

  /**
   * 펀딩율 히스토리 (백테스트에서는 빈 배열)
   */
  getFundingRateHistory(symbol: string): number[] {
    return [];
  }

  /**
   * 현재 시간 반환
   */
  getCurrentTime(): number {
    return this.currentTime;
  }

  /**
   * 특정 심볼의 모든 캔들 반환
   */
  getAllCandles(symbol: string, timeframe: string): Candle[] {
    const key = `${symbol}_${timeframe}`;
    return this.candles.get(key) || [];
  }

  /**
   * 데이터 초기화
   */
  clear() {
    this.candles.clear();
    this.currentPrices.clear();
    this.fundingRates.clear();
    this.currentIndex.clear();
    this.currentTime = 0;
  }
}
