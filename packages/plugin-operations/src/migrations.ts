import type { Pool } from 'pg';
import migration001 from '../migrations/001_operations.sql?raw';
import migration002 from '../migrations/002_live_launch.sql?raw';
import migration003 from '../migrations/003_inbound_gateway.sql?raw';
import migration004 from '../migrations/004_inbound_overflow.sql?raw';
import migration005 from '../migrations/005_inbound_carrier.sql?raw';
import { transaction } from './database.ts';

const migrations = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
] as const;

export async function runOperationsMigrations(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-operations-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS ovo_ops_schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM ovo_ops_schema_migrations',
    );
    const versions = new Set(applied.rows.map((row) => row.version));
    for (const migration of migrations) {
      if (versions.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO ovo_ops_schema_migrations (version) VALUES ($1)', [
        migration.version,
      ]);
    }
  });
}
