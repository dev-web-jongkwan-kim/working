import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from 'dotenv';
import { Trade } from '../../entities/trade.entity';
import { Position } from '../../entities/position.entity';
import { Signal } from '../../entities/signal.entity';
import { StrategyLog } from '../../entities/strategy-log.entity';
import { SystemLog } from '../../entities/system-log.entity';
import { RiskEvent } from '../../entities/risk-event.entity';
import { MarketRegimeHistory } from '../../entities/market-regime-history.entity';
import { DailyPerformance } from '../../entities/daily-performance.entity';
import { LotteryOrder } from '../../lottery/entities/lottery-order.entity';
import { LotterySelectionHistory } from '../../lottery/entities/lottery-selection-history.entity';
import { LotteryPerformance } from '../../lottery/entities/lottery-performance.entity';
import { ManualTrade } from '../../entities/manual-trade.entity';
import { BacktestRun } from '../../backtest/entities/backtest-run.entity';
import { BacktestTrade } from '../../backtest/entities/backtest-trade.entity';

config();

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '5432'),
  username: process.env.DATABASE_USER || 'trading_user',
  password: process.env.DATABASE_PASSWORD || 'trading_password',
  database: process.env.DATABASE_NAME || 'trading_system',
  entities: [
    Trade,
    Position,
    Signal,
    StrategyLog,
    SystemLog,
    RiskEvent,
    MarketRegimeHistory,
    DailyPerformance,
    LotteryOrder,
    LotterySelectionHistory,
    LotteryPerformance,
    ManualTrade,
    BacktestRun,
    BacktestTrade,
  ],
  migrations: ['dist/migrations/*.js'],
  synchronize: process.env.NODE_ENV === 'development', // Auto-sync in dev
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : false,
  extra: {
    // Connection pool settings
    max: 20,
    min: 5,
    idleTimeoutMillis: 30000,
  },
};

const dataSource = new DataSource(dataSourceOptions);

export default dataSource;
