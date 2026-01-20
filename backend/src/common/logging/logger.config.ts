import * as winston from 'winston';
import * as DailyRotateFile from 'winston-daily-rotate-file';
import { join } from 'path';

// Custom format for console output
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, context, ...meta }) => {
    const contextStr = context ? `[${context}]` : '';
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} ${level} ${contextStr} ${message} ${metaStr}`;
  }),
);

// Custom format for file output (JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Daily rotate file transport for all logs
const dailyRotateFileTransport = new DailyRotateFile({
  dirname: join(process.cwd(), 'logs'),
  filename: 'trading-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d', // Keep logs for 14 days
  format: fileFormat,
  level: 'debug',
});

// Daily rotate file transport for errors only
const errorRotateFileTransport = new DailyRotateFile({
  dirname: join(process.cwd(), 'logs'),
  filename: 'trading-error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d', // Keep error logs for 30 days
  format: fileFormat,
  level: 'error',
});

// Console transport
const consoleTransport = new winston.transports.Console({
  format: consoleFormat,
  level: process.env.LOG_LEVEL || 'debug',
});

// Create winston logger
export const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'debug',
  transports: [
    consoleTransport,
    dailyRotateFileTransport,
    errorRotateFileTransport,
  ],
  exitOnError: false,
});

// Log levels
export const LogLevels = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
  DEBUG: 'debug',
} as const;
