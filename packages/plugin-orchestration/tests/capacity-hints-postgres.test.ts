import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../src/postgres.ts';
import { DlqReconcilerTask } from '../src/background-tasks.ts';

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
    expect(
      (
        await store.pool.query<{ hinted_at: string | null }>(
          `SELECT column_name AS hinted_at FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'ovo_jobs' AND column_name = 'hinted_at'`,
          [schema],
        )
      ).rows[0]?.hinted_at,
    ).toBe('hinted_at');
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
    expect(
      (await store.pool.query('SELECT hinted_at, hint_count FROM ovo_jobs WHERE id = $1', [id]))
        .rows[0],
    ).toEqual({ hinted_at: null, hint_count: 0 });
    expect(
      (
        await store.pool.query(
          'SELECT count(*)::int AS count FROM ovo_outbox WHERE aggregate_id = $1',
          [id],
        )
      ).rows[0]?.count,
    ).toBe(0);
    await store.pool.query(
      `UPDATE ovo_jobs SET not_before = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 1, poisoned: [] });
  });

  it('does not hint an owned job while its lease remains live', async () => {
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
         owner_id, owner_epoch, lease_expires_at, not_before)
       VALUES ($1, $2, $3, '{}'::jsonb, 'owned',
         'worker', 1, now() + interval '30 seconds', now() - interval '1 second')`,
      [id, schema, id],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 0, poisoned: [] });
    expect(
      (await store.pool.query('SELECT hinted_at, hint_count FROM ovo_jobs WHERE id=$1', [id]))
        .rows[0],
    ).toEqual({ hinted_at: null, hint_count: 0 });
    await store.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [id],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 1, poisoned: [] });
  });

  it('does not hint queued work before not_before or repeat a recent hint', async () => {
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status, not_before)
       VALUES ($1, $2, $3, '{}'::jsonb, 'queued', now() + interval '30 seconds')`,
      [id, schema, id],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 0, poisoned: [] });
    await store.pool.query(
      `UPDATE ovo_jobs SET not_before = now() - interval '1 second',
         hinted_at = now() - interval '2 seconds' WHERE id=$1`,
      [id],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 0, poisoned: [] });
    await store.pool.query(
      `UPDATE ovo_jobs SET hinted_at = now() - interval '151 seconds' WHERE id=$1`,
      [id],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 1, poisoned: [] });
    expect(
      (await store.pool.query('SELECT hint_count FROM ovo_jobs WHERE id=$1', [id])).rows[0],
    ).toEqual({ hint_count: 1 });
  });

  it('skips a row locked by another sweeper and never double-claims concurrent work', async () => {
    const lockedId = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status, not_before)
       VALUES ($1, $2, $3, '{}'::jsonb, 'queued', now() - interval '1 second')`,
      [lockedId, schema, lockedId],
    );
    const holder = await store.pool.connect();
    let sweep: ReturnType<typeof store.hints.sweep> | undefined;
    let completedWhileLocked = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM ovo_jobs WHERE id=$1 FOR UPDATE', [lockedId]);
      sweep = store.hints.sweep();
      completedWhileLocked = await Promise.race([
        sweep.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
    } finally {
      await holder.query('COMMIT');
      holder.release();
      await sweep;
    }
    expect(completedWhileLocked).toBe(true);
    const results = await Promise.all([store.hints.sweep(), store.hints.sweep()]);
    expect(results.map((item) => item.hinted).sort()).toEqual([0, 1]);
    expect(
      (await store.pool.query('SELECT hint_count FROM ovo_jobs WHERE id=$1', [lockedId])).rows[0],
    ).toEqual({ hint_count: 1 });
    expect(
      (
        await store.pool.query(
          "SELECT count(*)::int AS count FROM ovo_outbox WHERE aggregate_id=$1 AND topic='job.eligible'",
          [lockedId],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('migrates away writer state and persists the last published signal across store instances', async () => {
    const tables = await store.pool.query<{ writes: string | null; leases: string | null }>(
      `SELECT to_regclass('ovo_capacity_writes')::text AS writes,
         to_regclass('ovo_capacity_leases')::text AS leases`,
    );
    expect(tables.rows[0]).toEqual({ writes: null, leases: null });
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs(id,workspace_id,idempotency_key,payload,status)
       VALUES ($1,$2,$3,'{}'::jsonb,'superseded')`,
      [id, schema, id],
    );
    const signal = {
      requiredSlots: 3,
      provisionedTasks: 2,
      busySlots: 1,
      readyIdleSlots: 1,
      eligibleJobs: 2,
      campaignDemand: 0,
      oldestEligibleJobAgeSeconds: 5,
      at: new Date(Date.now() - 2_000),
    };
    await store.recordCapacitySignal(signal);
    const newer = { ...signal, requiredSlots: 4, at: new Date(signal.at.getTime() + 1_000) };
    const delayed = { ...signal, requiredSlots: 99, at: new Date(signal.at.getTime() - 60_000) };
    await store.recordCapacitySignal(newer);
    await store.recordCapacitySignal(delayed);
    const reader = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    try {
      const row = await reader.query<{ signal: Record<string, unknown>; age_ms: string }>(
        `SELECT signal, extract(epoch FROM (now()-signal_at))*1000 AS age_ms
         FROM ovo_capacity_signal_latest WHERE service_key='workers'`,
      );
      expect(row.rows[0]?.signal).toMatchObject({ requiredSlots: 4, at: newer.at.toISOString() });
      expect(Number(row.rows[0]?.age_ms)).toBeGreaterThanOrEqual(0);
      await store.migrate();
      expect(
        (
          await reader.query(`SELECT count(*)::int AS count
        FROM ovo_orch_schema_migrations WHERE version=6`)
        ).rows[0]?.count,
      ).toBe(1);
    } finally {
      await reader.end();
    }
  });

  it('uses the oldest active slot observation so one stale slot blocks the signal', async () => {
    await store.capacity.reportWorker({
      workerId: 'slot-old',
      state: 'active',
      ownershipEpoch: 1,
      leaseMs: 120_000,
    });
    await store.capacity.reportWorker({
      workerId: 'slot-new',
      state: 'active',
      ownershipEpoch: 1,
      leaseMs: 120_000,
    });
    await store.pool.query(
      `UPDATE ovo_worker_slots SET observed_at = now() - interval '40 seconds' WHERE worker_id = 'slot-old'`,
    );
    const snapshot = await store.readCapacitySnapshot();
    expect(snapshot.counts.active).toBe(2);
    expect(Date.now() - snapshot.observedAtMs).toBeGreaterThan(30_000);
  });

  it('caps advisory-locked idle floor tokens and preserves only the current epoch marker', async () => {
    const first = `floor-${randomUUID()}`;
    const second = `floor-${randomUUID()}`;
    const claim = (workerId: string, ownershipEpoch = 1) =>
      store.claimInboundFloorToken({
        workerId,
        organizationId: schema,
        ownershipEpoch,
        floor: 1,
        leaseMs: 15_000,
      });
    const winners = await Promise.all([claim(first), claim(second)]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const winner = winners[0] ? first : second;
    const loser = winners[0] ? second : first;
    await store.reportWorker({
      workerId: winner,
      state: 'ready_idle',
      ownershipEpoch: 1,
      leaseMs: 15_000,
      metadata: { infrastructure: 'sample' },
    });
    const token = (
      await store.pool.query(`SELECT metadata FROM ovo_worker_slots WHERE worker_id = $1`, [winner])
    ).rows[0]?.metadata;
    expect(token).toMatchObject({
      inboundFloorToken: true,
      inboundFloorOrganizationId: schema,
      infrastructure: 'sample',
    });
    expect(await claim(loser)).toBe(false);
    expect(await store.releaseInboundFloorToken(winner, 0)).toBe(false);
    expect(await claim(loser)).toBe(false);
    expect(await store.releaseInboundFloorToken(winner, 1)).toBe(true);
    expect(await claim(loser)).toBe(true);
    expect(await claim(winner, 0)).toBe(false);
    await store.pool.query(
      `UPDATE ovo_worker_slots SET lease_expires_at = now() - interval '1 second'
       WHERE worker_id = $1`,
      [loser],
    );
    await store.reportWorker({
      workerId: loser,
      state: 'ready_idle',
      ownershipEpoch: 1,
      leaseMs: 15_000,
    });
    expect(
      (
        await store.pool.query(
          `SELECT metadata->>'inboundFloorToken' AS token FROM ovo_worker_slots WHERE worker_id = $1`,
          [loser],
        )
      ).rows[0]?.token,
    ).toBeNull();
    expect(await claim(winner, 2)).toBe(true);
  });

  it('fails a repeatedly hinted unstarted job terminally without adding another outbox row', async () => {
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
         not_before, hint_count)
       VALUES ($1, $2, 'poison', '{}'::jsonb, 'queued', now() - interval '1 second', 20)`,
      [id, schema],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 0, poisoned: [id] });
    expect(
      (
        await store.pool.query(
          'SELECT status, last_error, hint_count FROM ovo_jobs WHERE id = $1',
          [id],
        )
      ).rows[0],
    ).toEqual({ status: 'failed', last_error: 'hint_exhausted', hint_count: 21 });
    expect(
      (
        await store.pool.query(
          'SELECT count(*)::int AS count FROM ovo_outbox WHERE aggregate_id = $1',
          [id],
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it('does not poison a hinted owned job that already has a dial request', async () => {
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
         owner_id, owner_epoch, lease_expires_at, dial_request_id, not_before, hint_count)
       VALUES ($1, $2, 'post-dial', '{}'::jsonb, 'owned',
         'worker', 1, now() - interval '1 second', 'dial-request', now() - interval '1 second', 20)`,
      [id, schema],
    );
    expect(await store.hints.sweep()).toEqual({ hinted: 1, poisoned: [] });
    expect(
      (
        await store.pool.query(
          'SELECT status, last_error, hint_count FROM ovo_jobs WHERE id = $1',
          [id],
        )
      ).rows[0],
    ).toEqual({ status: 'owned', last_error: null, hint_count: 21 });
    expect(
      (
        await store.pool.query(
          'SELECT count(*)::int AS count FROM ovo_outbox WHERE aggregate_id = $1',
          [id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it('resets a DLQ hint in Postgres and lets the sweeper rehint due work', async () => {
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
         not_before, hinted_at, hint_count)
       VALUES ($1, $2, 'dlq', '{}'::jsonb, 'queued', now() - interval '1 second', now(), 1)`,
      [id, schema],
    );
    const deleted: string[] = [];
    const task = new DlqReconcilerTask(store, {
      receive: async () => [
        {
          messageId: 'dlq-1',
          receiptHandle: 'receipt-1',
          body: JSON.stringify({ schemaVersion: 1, jobId: id }),
        },
      ],
      delete: async (message) => {
        deleted.push(message.receiptHandle);
      },
    });
    await task.tick(new AbortController().signal);
    expect(deleted).toEqual(['receipt-1']);
    expect(
      (await store.pool.query('SELECT hinted_at FROM ovo_jobs WHERE id = $1', [id])).rows[0]
        ?.hinted_at,
    ).toBeNull();
    expect(await store.hints.sweep()).toEqual({ hinted: 1, poisoned: [] });
    expect(
      (
        await store.pool.query(
          'SELECT count(*)::int AS count FROM ovo_outbox WHERE aggregate_id = $1',
          [id],
        )
      ).rows[0]?.count,
    ).toBe(1);
  });
});
