import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import migration001 from '../migrations/001_durable_orchestration.sql?raw';
import migration002 from '../migrations/002_session_lifecycle.sql?raw';
import migration003 from '../migrations/003_carrier_identity.sql?raw';
import migration004 from '../migrations/004_carrier_scope.sql?raw';
import migration005 from '../migrations/005_inbound_carrier_selection.sql?raw';
import { PostgresOrchestrationStore } from '../src/postgres.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!url)('migration schema boundary', () => {
  it('refuses migration 006 before its broad status scan can remove an unrelated CHECK', async () => {
    const schema = `orch_guard_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const seed = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const store = new PostgresOrchestrationStore({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    try {
      for (const sql of [migration001, migration002, migration003, migration004, migration005])
        await seed.query(sql);
      await seed.query(`CREATE TABLE ovo_orch_schema_migrations (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      await seed.query(
        'INSERT INTO ovo_orch_schema_migrations (version) SELECT generate_series(1, 5)',
      );
      await seed.query(
        "ALTER TABLE ovo_jobs ADD CONSTRAINT ovo_jobs_status_shadow_check CHECK (status <> 'blocked')",
      );
      let refused: unknown;
      try {
        await store.migrate();
      } catch (error) {
        refused = error;
      }
      const checks = await seed.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid='ovo_jobs'::regclass AND conname='ovo_jobs_status_shadow_check'`,
      );
      expect(checks.rows.map((row) => row.conname)).toEqual(['ovo_jobs_status_shadow_check']);
      expect(String(refused)).toContain('manual review of status constraints');
      expect(
        (
          await seed.query<{ version: number }>(
            'SELECT max(version) AS version FROM ovo_orch_schema_migrations',
          )
        ).rows[0]?.version,
      ).toBe(5);
    } finally {
      await store.close();
      await seed.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('does not adopt tables visible only through a later search_path schema', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const own = `orch_own_${suffix}`;
    const foreign = `orch_foreign_${suffix}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${own}`);
    await admin.query(`CREATE SCHEMA ${foreign}`);
    const seed = new Pool({ connectionString: url, options: `-c search_path=${foreign}` });
    const store = new PostgresOrchestrationStore({
      connectionString: url,
      options: `-c search_path=${own},${foreign}`,
    });
    try {
      await seed.query(migration001);
      await seed.query(migration002);
      await store.migrate();
      expect(
        (
          await admin.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM information_schema.tables
           WHERE table_schema = $1 AND table_name IN ('ovo_jobs', 'ovo_session_routes')`,
            [own],
          )
        ).rows[0]?.count,
      ).toBe('2');
      expect(
        (
          await admin.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = 'ovo_session_routes' AND column_name = 'carrier_id'`,
            [foreign],
          )
        ).rows[0]?.count,
      ).toBe('0');
    } finally {
      await store.close();
      await seed.end();
      await admin.query(`DROP SCHEMA ${own} CASCADE`);
      await admin.query(`DROP SCHEMA ${foreign} CASCADE`);
      await admin.end();
    }
  });
});
