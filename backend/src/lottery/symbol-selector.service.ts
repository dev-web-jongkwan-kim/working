import { Injectable, Logger } from '@nestjs/common';

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
export class SymbolSelectorService {
  private readonly logger = new Logger(SymbolSelectorService.name);

  /**
   * Select top 3 from candidates (with category diversity)
   */
  async selectTop3(candidates: LotteryCandidate[]): Promise<LotteryCandidate[]> {
    if (candidates.length === 0) {
      this.logger.warn('No candidates to select from');
      return [];
    }

    // Sort by score
    const sorted = candidates.sort((a, b) => b.score - a.score);

    this.logger.log(`Total candidates: ${sorted.length}`);
    this.logger.log(`Top 5 scores: ${
      sorted.slice(0, 5).map(c => `${c.symbol}(${c.score})`).join(', ')
    }`);

    // === Ensure category diversity ===
    const selected: LotteryCandidate[] = [];
    const usedCategories = new Set<string>();

    for (const candidate of sorted) {
      if (selected.length >= 3) break;

      const category = this.getCategory(candidate.symbol);

      // Avoid duplicate categories if possible
      if (usedCategories.has(category) && usedCategories.size < 3) {
        continue;
      }

      selected.push(candidate);
      usedCategories.add(category);
    }

    // Fill remaining slots if needed
    if (selected.length < 3) {
      for (const candidate of sorted) {
        if (selected.length >= 3) break;
        if (!selected.find(c => c.symbol === candidate.symbol)) {
          selected.push(candidate);
        }
      }
    }

    this.logger.log(`Selected: ${selected.map(c =>
      `${c.symbol}(${c.score}, ${this.getCategory(c.symbol)})`
    ).join(', ')}`);

    return selected;
  }

  /**
   * Get coin category
   */
  private getCategory(symbol: string): string {
    const base = symbol.replace('USDT', '').replace('1000', '');

    // Meme coins
    if (/DOGE|SHIB|PEPE|WIF|BONK|FLOKI|MEME|SATS/.test(base)) {
      return 'MEME';
    }

    // Layer 1
    if (/SOL|AVAX|NEAR|APT|SUI|SEI|INJ|TIA|ATOM|FTM/.test(base)) {
      return 'L1';
    }

    // Layer 2
    if (/ARB|OP|MATIC|METIS|IMX|STRK/.test(base)) {
      return 'L2';
    }

    // DeFi
    if (/UNI|AAVE|CRV|MKR|COMP|SUSHI|CAKE|JUP|PENDLE/.test(base)) {
      return 'DEFI';
    }

    return 'OTHER';
  }
}
