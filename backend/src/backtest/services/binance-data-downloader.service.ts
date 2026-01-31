import { Injectable } from '@nestjs/common';
import { CustomLoggerService } from '../../common/logging/custom-logger.service';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Extract } from 'unzipper';

export interface Candle {
  symbol: string;
  timeframe: string;
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  takerBuyVolume: number;
  takerBuyQuoteVolume: number;
}

@Injectable()
export class BinanceDataDownloaderService {
  private readonly dataDir = path.join(process.cwd(), 'backtest-data');
  private readonly baseUrl = 'https://data.binance.vision/data/futures/um/daily/klines';

  constructor(private readonly logger: CustomLoggerService) {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  async downloadData(
    symbol: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    const dates = this.getDateRange(startDate, endDate);

    this.logger.log(
      `Downloading ${symbol} ${timeframe} data: ${dates.length} days`,
      'BinanceDataDownloader',
    );

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dateStr = this.formatDate(date);
      const progress = Math.round(((i + 1) / dates.length) * 100);

      if (onProgress) {
        onProgress(progress, `Downloading ${symbol} ${dateStr}`);
      }

      try {
        const candles = await this.downloadDayData(symbol, timeframe, dateStr);
        allCandles.push(...candles);
      } catch (error) {
        this.logger.warn(
          `Failed to download ${symbol} ${timeframe} ${dateStr}: ${error.message}`,
          'BinanceDataDownloader',
        );
      }
    }

    // Sort by time
    allCandles.sort((a, b) => a.openTime - b.openTime);

    this.logger.log(
      `Downloaded ${allCandles.length} candles for ${symbol} ${timeframe}`,
      'BinanceDataDownloader',
    );

    return allCandles;
  }

  private async downloadDayData(
    symbol: string,
    timeframe: string,
    dateStr: string,
  ): Promise<Candle[]> {
    const cacheFile = path.join(
      this.dataDir,
      `${symbol}-${timeframe}-${dateStr}.json`,
    );

    // Check cache
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return cached;
    }

    const url = `${this.baseUrl}/${symbol}/${timeframe}/${symbol}-${timeframe}-${dateStr}.zip`;
    const zipFile = path.join(this.dataDir, `${symbol}-${timeframe}-${dateStr}.zip`);
    const csvFile = path.join(this.dataDir, `${symbol}-${timeframe}-${dateStr}.csv`);

    // Download ZIP
    await this.downloadFile(url, zipFile);

    // Extract ZIP
    await this.extractZip(zipFile, this.dataDir);

    // Parse CSV
    const candles = await this.parseCsv(csvFile, symbol, timeframe);

    // Cache as JSON
    fs.writeFileSync(cacheFile, JSON.stringify(candles));

    // Cleanup
    if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
    if (fs.existsSync(csvFile)) fs.unlinkSync(csvFile);

    return candles;
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(dest);

      https.get(url, (response) => {
        if (response.statusCode === 404) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error('File not found'));
          return;
        }

        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          this.downloadFile(response.headers.location!, dest)
            .then(resolve)
            .catch(reject);
          return;
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (err) => {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
    });
  }

  private async extractZip(zipFile: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      createReadStream(zipFile)
        .pipe(Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject);
    });
  }

  private async parseCsv(
    csvFile: string,
    symbol: string,
    timeframe: string,
  ): Promise<Candle[]> {
    const content = fs.readFileSync(csvFile, 'utf8');
    const lines = content.trim().split('\n');
    const candles: Candle[] = [];

    // Skip header if exists
    const startIdx = lines[0].includes('open_time') ? 1 : 0;

    for (let i = startIdx; i < lines.length; i++) {
      const cols = lines[i].split(',');
      if (cols.length < 11) continue;

      candles.push({
        symbol,
        timeframe,
        openTime: parseInt(cols[0]),
        open: parseFloat(cols[1]),
        high: parseFloat(cols[2]),
        low: parseFloat(cols[3]),
        close: parseFloat(cols[4]),
        volume: parseFloat(cols[5]),
        closeTime: parseInt(cols[6]),
        quoteVolume: parseFloat(cols[7]),
        trades: parseInt(cols[8]),
        takerBuyVolume: parseFloat(cols[9]),
        takerBuyQuoteVolume: parseFloat(cols[10]),
      });
    }

    return candles;
  }

  private getDateRange(start: Date, end: Date): Date[] {
    const dates: Date[] = [];
    const current = new Date(start);
    current.setHours(0, 0, 0, 0);

    while (current <= end) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }

    return dates;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Download funding rate history for a symbol
   * @param symbol Trading pair
   * @param startDate Start date
   * @param endDate End date
   * @returns Array of funding rates (oldest first)
   */
  async downloadFundingHistory(
    symbol: string,
    startDate: Date,
    endDate: Date,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<number[]> {
    const cacheFile = path.join(
      this.dataDir,
      `${symbol}-funding-${this.formatDate(startDate)}-${this.formatDate(endDate)}.json`,
    );

    // Check cache
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      return cached;
    }

    const fundingRates: number[] = [];
    const baseUrl = 'https://fapi.binance.com/fapi/v1/fundingRate';

    let currentStartTime = startDate.getTime();
    const endTime = endDate.getTime();
    const batchSize = 1000; // API limit

    this.logger.log(
      `Downloading funding history for ${symbol}`,
      'BinanceDataDownloader',
    );

    while (currentStartTime < endTime) {
      try {
        const url = `${baseUrl}?symbol=${symbol}&startTime=${currentStartTime}&endTime=${endTime}&limit=${batchSize}`;

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data) || data.length === 0) {
          break;
        }

        for (const item of data) {
          fundingRates.push(parseFloat(item.fundingRate));
        }

        // Move to next batch (funding is every 8 hours)
        const lastTime = data[data.length - 1].fundingTime;
        currentStartTime = lastTime + 1;

        if (onProgress) {
          const progress = Math.min(100, Math.round(((currentStartTime - startDate.getTime()) / (endTime - startDate.getTime())) * 100));
          onProgress(progress, `Downloading ${symbol} funding rates`);
        }

        // Rate limit
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        this.logger.warn(
          `Failed to download funding for ${symbol}: ${error.message}`,
          'BinanceDataDownloader',
        );
        break;
      }
    }

    // Cache result
    if (fundingRates.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify(fundingRates));
    }

    this.logger.log(
      `Downloaded ${fundingRates.length} funding rates for ${symbol}`,
      'BinanceDataDownloader',
    );

    return fundingRates;
  }
}
