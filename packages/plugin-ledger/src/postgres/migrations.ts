import type { Pool } from 'pg';
import migration from '../../migrations/001_cost_ledger.sql?raw';
import { transaction } from './database.ts';

export async function runCostMigrations(pool: Pool): Promise<void> {
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-cost-ledger-migrations-v1'))");
    await client.query(migration);
  });
}
