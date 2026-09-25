import type { Pool } from 'pg';
import migration001 from '../../migrations/001_durable_orchestration.sql?raw';
import migration002 from '../../migrations/002_session_lifecycle.sql?raw';
import migration003 from '../../migrations/003_carrier_identity.sql?raw';
import migration004 from '../../migrations/004_carrier_scope.sql?raw';
import migration005 from '../../migrations/005_inbound_carrier_selection.sql?raw';

const migrations = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
] as const;

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-orchestration-migrations'))");
    await client.query(`CREATE TABLE IF NOT EXISTS ovo_orch_schema_migrations (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const rows = await client.query<{ version: number }>(
      'SELECT version FROM ovo_orch_schema_migrations ORDER BY version',
    );
    const versions = new Set<number>();
    for (const row of rows.rows) versions.add(row.version);
    // The first two migrations predate this ledger. Adopt only complete old schemas.
    for (const [version, tables] of [
      [
        1,
        [
          'ovo_jobs',
          'ovo_job_attempts',
          'ovo_outbox',
          'ovo_worker_slots',
          'ovo_capacity_leases',
          'ovo_capacity_writes',
        ],
      ],
      [2, ['ovo_session_routes', 'ovo_carrier_callbacks']],
    ] as const) {
      if (versions.has(version)) continue;
      const result = await client.query<{ present: boolean }>(
        `SELECT bool_and(to_regclass(format('%I.%I', current_schema(), table_name)) IS NOT NULL) AS present
         FROM unnest($1::text[]) AS table_name`,
        [tables],
      );
      if (result.rows[0]?.present) {
        await client.query('INSERT INTO ovo_orch_schema_migrations (version) VALUES ($1)', [
          version,
        ]);
        versions.add(version);
      }
    }
    const missing = migrations.filter((migration) => !versions.has(migration.version));
    for (const { version, sql } of missing) {
      await client.query(sql);
      await client.query('INSERT INTO ovo_orch_schema_migrations (version) VALUES ($1)', [version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
