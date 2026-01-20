import { Injectable, Logger } from '@nestjs/common';
import { SymbolFetcherService } from '../dual-strategy/services/data/symbol-fetcher.service';

@Injectable()
export class VolumeProviderService {
  private readonly logger = new Logger(VolumeProviderService.name);

  constructor(
    private readonly symbolFetcher: SymbolFetcherService,
  ) {}

  /**
   * Get top 100 symbols by 24h volume
   */
  async getTop100ByVolume(): Promise<string[]> {
    try {
      const symbols = await this.symbolFetcher.getTopSymbols(100);
      this.logger.log(`Fetched ${symbols.length} symbols by volume`);
      return symbols;
    } catch (error) {
      this.logger.error(`Failed to fetch symbols: ${error.message}`);
      return [];
    }
  }
}
