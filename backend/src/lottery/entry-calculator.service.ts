import { Injectable, Logger } from '@nestjs/common';
import { BinanceService } from '../dual-strategy/services/data/binance.service';
import { Indicators } from '../dual-strategy/utils/indicators';
import { Candle } from '../dual-strategy/interfaces/candle.interface';

interface LotteryCandidate {
  symbol: string;
  score: number;
  signals: {
    funding_rate: number;
    funding_level: 'EXTREME' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'N/A';
    change_4h: number;
    momentum: 'EXTREME' | 'VERY_STRONG' | 'STRONG' | 'MEDIUM' | 'WEAK' | 'N/A';
    oi_change: number;
    oi_level: 'SURGE' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'N/A';
    rsi: number;
    rsi_level: 'EXTREME' | 'VERY_HIGH' | 'HIGH' | 'MEDIUM' | 'WEAK' | 'N/A';
    volume_ratio?: number;
    volume_spike?: boolean;
    btc_change_1h?: number;
    btc_dropping?: boolean;
    volatility_24h?: number;
    high_volatility?: boolean;
    volume_24h?: number;
    max_leverage?: number;
    change_7d?: number;
    coin_type?: 'MAJOR' | 'TOP10' | 'PUMPING' | 'OTHERS';
  };
  timestamp: number;
}

@Injectable()
export class EntryCalculatorService {
  private readonly logger = new Logger(EntryCalculatorService.name);

  // Standard entry depths by category (industry experience)
  private readonly STANDARD_DEPTHS = {
    'MEME': 0.09,   // -9% (high volatility)
    'L1': 0.075,    // -7.5%
    'L2': 0.075,    // -7.5%
    'DEFI': 0.07,   // -7%
    'OTHER': 0.08   // -8% (default)
  };

  constructor(
    private readonly binanceService: BinanceService,
  ) {}

  /**
   * Calculate entry price for candidate
   * 코인 타입별 고정 % 방식
   * - 대장주 (BTC, ETH): -18%
   * - 메이저 (Top 10): -28%
   * - 급등 알트: -38%
   * - 일반 알트: -48%
   */
  async calculateEntryPrice(candidate: LotteryCandidate): Promise<number> {
    const { symbol, signals } = candidate;

    // Get current price
    const ticker = await this.binanceService.getSymbolPriceTicker(symbol);
    const currentPrice = parseFloat(ticker.price);

    // 코인 타입에 따른 진입가 깊이
    const coinType = signals.coin_type || 'OTHERS';
    let depthPercent: number;

    switch (coinType) {
      case 'MAJOR':   // BTC, ETH
        depthPercent = 0.18; // -18%
        break;
      case 'TOP10':   // 메이저 알트
        depthPercent = 0.28; // -28%
        break;
      case 'PUMPING': // 급등 알트
        depthPercent = 0.38; // -38%
        break;
      case 'OTHERS':  // 일반 알트
      default:
        depthPercent = 0.48; // -48%
        break;
    }

    const entryPrice = currentPrice * (1 - depthPercent);

    this.logger.log(
      `${symbol} 로터리 진입가: ${entryPrice.toFixed(6)} ` +
      `(Type=${coinType}, Depth=-${(depthPercent * 100).toFixed(0)}%, Current=${currentPrice.toFixed(6)})`
    );

    return entryPrice;
  }

  /**
   * Get category (same as selector)
   */
  private getCategory(symbol: string): string {
    const base = symbol.replace('USDT', '').replace('1000', '');

    if (/DOGE|SHIB|PEPE|WIF|BONK|FLOKI|MEME|SATS/.test(base)) return 'MEME';
    if (/SOL|AVAX|NEAR|APT|SUI|SEI|INJ|TIA|ATOM|FTM/.test(base)) return 'L1';
    if (/ARB|OP|MATIC|METIS|IMX|STRK/.test(base)) return 'L2';
    if (/UNI|AAVE|CRV|MKR|COMP|SUSHI|CAKE|JUP|PENDLE/.test(base)) return 'DEFI';

    return 'OTHER';
  }
}
