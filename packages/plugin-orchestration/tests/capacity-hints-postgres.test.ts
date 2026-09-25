import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../src/postgres.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!url)('capacity and hint PostgreSQL eligibility', () => {
  const schema = `o1_capacity_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let store: PostgresOrchestrationStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    store = new PostgresOrchestrationStore({
      connectionString: url,
      options: `-c search_path=${schema}`,
      application_name: schema,
    });
    await store.migrate();
    // Removed when the separately reviewed hint migration joins this branch.
    await store.pool.query('ALTER TABLE ovo_jobs ADD COLUMN IF NOT EXISTS hinted_at timestamptz');
    await store.pool.query('ALTER TABLE ovo_jobs ADD COLUMN IF NOT EXISTS hint_count int NOT NULL DEFAULT 0');
  });

  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('does not hint an expired live lease before its deferred not_before time', async () => {
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
         owner_id, owner_epoch, lease_expires_at, not_before)
       VALUES ($1, $2, 'deferred-live', '{}'::jsonb, 'reconcile_required',
         'worker', 1, now() - interval '1 second', now() + interval '30 seconds')`,
      [id, schema],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 0, poisoned: [] });
    expect((await store.pool.query('SELECT hinted_at, hint_count FROM ovo_jobs WHERE id = $1', [id])).rows[0])
      .toEqual({ hinted_at: null, hint_count: 0 });
    expect((await store.pool.query('SELECT count(*)::int AS count FROM ovo_outbox WHERE aggregate_id = $1', [id])).rows[0]?.count)
      .toBe(0);
    await store.pool.query(`UPDATE ovo_jobs SET not_before = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await store.hints.sweep()).toEqual({ hinted: 1, poisoned: [] });
  });

  it('uses the oldest active slot observation so one stale slot blocks the signal', async () => {
    await store.capacity.reportWorker({ workerId: 'slot-old', state: 'active', ownershipEpoch: 1, leaseMs: 120_000 });
    await store.capacity.reportWorker({ workerId: 'slot-new', state: 'active', ownershipEpoch: 1, leaseMs: 120_000 });
    await store.pool.query(`UPDATE ovo_worker_slots SET observed_at = now() - interval '40 seconds' WHERE worker_id = 'slot-old'`);
    const snapshot = await store.readCapacitySnapshot();
    expect(snapshot.counts.active).toBe(2);
    expect(Date.now() - snapshot.observedAtMs).toBeGreaterThan(30_000);
  });
});
