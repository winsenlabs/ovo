import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import migration001 from '../migrations/001_cost_ledger.sql?raw';
import { PostgresCostLedger } from '../src/postgres.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('legacy cost-ledger migration recovery', () => {
  it('repairs a partial 001 install before recording version 2', async () => {
    const schema = `cost_partial_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    try {
      await pool.query(migration001);
      await pool.query('DROP TABLE ovo_cost_budget_adjustments');
      await pool.query('DELETE FROM ovo_cost_schema_migrations WHERE version=1');
      await new PostgresCostLedger(pool).migrate();
      expect(
        (await pool.query('SELECT version FROM ovo_cost_schema_migrations ORDER BY version')).rows,
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
      expect(
        (
          await pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ovo_cost_reservations' AND column_name='source_ref'",
          )
        ).rowCount,
      ).toBe(1);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('refuses a malformed pre-ledger price table instead of recording migration 001', async () => {
    const schema = `cost_malformed_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    try {
      await pool.query(migration001);
      await pool.query('ALTER TABLE ovo_cost_price_cards DROP COLUMN block_quantity');
      await pool.query('DELETE FROM ovo_cost_schema_migrations WHERE version=1');
      await expect(new PostgresCostLedger(pool).migrate()).rejects.toThrow(
        'Cost ledger legacy schema is incomplete: ovo_cost_price_cards.block_quantity',
      );
      expect((await pool.query('SELECT version FROM ovo_cost_schema_migrations')).rows).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('refuses a pre-ledger price table missing its primary key', async () => {
    const schema = `cost_missing_pk_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: postgresUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    try {
      await pool.query(migration001);
      await pool.query(
        'ALTER TABLE ovo_cost_price_cards DROP CONSTRAINT ovo_cost_price_cards_pkey CASCADE',
      );
      await pool.query('DELETE FROM ovo_cost_schema_migrations WHERE version=1');
      await expect(new PostgresCostLedger(pool).migrate()).rejects.toThrow(
        'Cost ledger legacy schema is incomplete: ovo_cost_price_cards.primary_key',
      );
      expect((await pool.query('SELECT version FROM ovo_cost_schema_migrations')).rows).toEqual([]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
});
