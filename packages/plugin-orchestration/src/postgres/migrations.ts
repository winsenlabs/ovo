import type { Pool } from 'pg';
import { transaction } from './database.ts';
import migrationSql from '../../migrations/001_durable_orchestration.sql?raw';

export async function runMigrations(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-orchestration-migrations-v1'))");
    await client.query(migrationSql);
  });
}
