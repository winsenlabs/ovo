import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import migration001 from '../migrations/001_durable_orchestration.sql?raw';
import migration002 from '../migrations/002_session_lifecycle.sql?raw';
import { PostgresOrchestrationStore } from '../src/postgres.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!url)('migration schema boundary', () => {
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
