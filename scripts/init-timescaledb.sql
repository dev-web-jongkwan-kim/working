-- Initialize TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- This script will be run automatically when the PostgreSQL container starts
-- Additional table creation will be done via TypeORM migrations
