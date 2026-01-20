import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBoxRangeTables1768717039600 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Create active_boxes table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS active_boxes (
                id SERIAL PRIMARY KEY,
                box_id VARCHAR(100) UNIQUE NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                upper DECIMAL(20, 8) NOT NULL,
                lower DECIMAL(20, 8) NOT NULL,
                height DECIMAL(20, 8) NOT NULL,
                height_atr_ratio DECIMAL(10, 4) NOT NULL,
                atr DECIMAL(20, 8) NOT NULL,
                swing_highs JSONB NOT NULL,
                swing_lows JSONB NOT NULL,
                formation_time BIGINT NOT NULL,
                candles_in_box INTEGER NOT NULL,
                adx DECIMAL(10, 4) NOT NULL,
                plus_di DECIMAL(10, 4) NOT NULL,
                minus_di DECIMAL(10, 4) NOT NULL,
                volume_profile JSONB NOT NULL,
                confidence DECIMAL(10, 4) NOT NULL,
                grade VARCHAR(1) NOT NULL CHECK (grade IN ('A', 'B', 'C')),
                age_status VARCHAR(20) NOT NULL CHECK (age_status IN ('FRESH', 'OPTIMAL', 'AGING', 'EXPIRED')),
                is_valid BOOLEAN NOT NULL DEFAULT true,
                disabled_until TIMESTAMP NULL,
                disabled_reason TEXT NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create index on symbol for fast lookups
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_active_boxes_symbol ON active_boxes(symbol);
        `);

        // Create index on is_valid for filtering
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_active_boxes_is_valid ON active_boxes(is_valid);
        `);

        // Create box_history table
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS box_history (
                id SERIAL PRIMARY KEY,
                box_id VARCHAR(100) NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                grade VARCHAR(1) NOT NULL CHECK (grade IN ('A', 'B', 'C')),
                direction VARCHAR(10) NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
                entry_price DECIMAL(20, 8) NOT NULL,
                exit_price DECIMAL(20, 8) NULL,
                exit_reason VARCHAR(50) NULL,
                pnl_usd DECIMAL(20, 8) NULL,
                pnl_percent DECIMAL(10, 4) NULL,
                holding_minutes INTEGER NULL,
                metadata JSONB NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create index on box_id for relationship queries
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_box_history_box_id ON box_history(box_id);
        `);

        // Create index on symbol for analytics
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_box_history_symbol ON box_history(symbol);
        `);

        // Create index on created_at for time-based queries
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS idx_box_history_created_at ON box_history(created_at);
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop indexes first
        await queryRunner.query(`DROP INDEX IF EXISTS idx_box_history_created_at;`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_box_history_symbol;`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_box_history_box_id;`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_active_boxes_is_valid;`);
        await queryRunner.query(`DROP INDEX IF EXISTS idx_active_boxes_symbol;`);

        // Drop tables
        await queryRunner.query(`DROP TABLE IF EXISTS box_history;`);
        await queryRunner.query(`DROP TABLE IF EXISTS active_boxes;`);
    }

}
