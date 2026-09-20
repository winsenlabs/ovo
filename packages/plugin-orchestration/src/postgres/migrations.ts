import type { Pool } from 'pg';
import { transaction } from './database.ts';
import migration001 from '../../migrations/001_durable_orchestration.sql?raw';
import migration002 from '../../migrations/002_session_lifecycle.sql?raw';

export async function runMigrations(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-orchestration-migrations'))");
    await client.query(migration001);
    await client.query(migration002);
  });
}
