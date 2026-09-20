import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../src/postgres.ts';
import type { ClaimedJob } from '../src/types.ts';

class SimulatedConditionalOwner {
  private state: 'queued' | 'owned' = 'queued';
  private epoch = 0;

  async claim(workerId: string): Promise<ClaimedJob | undefined> {
    // This is intentionally a deterministic simulation of the SQL predicate, not PostgreSQL evidence.
    if (this.state !== 'queued') return undefined;
    this.state = 'owned';
    this.epoch += 1;
    return {
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId: 'ws-1',
      idempotencyKey: 'once',
      payload: {},
      status: 'owned',
      ownerId: workerId,
      ownerEpoch: this.epoch,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
  }
}

describe('conditional ownership simulation', () => {
  it('gives ten duplicate deliveries exactly one owner', async () => {
    const store = new SimulatedConditionalOwner();
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.claim(`worker-${index}`)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(new Set(claims.filter(Boolean).map((claim) => claim!.ownerEpoch))).toEqual(new Set([1]));
  });
});

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('PostgreSQL durable orchestration integration', () => {
  let store: PostgresOrchestrationStore;
  const workspaceId = `test-${randomUUID()}`;
  const jobIds: string[] = [];

  beforeAll(async () => {
    store = new PostgresOrchestrationStore({ connectionString: postgresUrl });
    await store.migrate();
  });

  afterAll(async () => {
    if (!store) return;
    await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id = ANY($1::uuid[])', [jobIds]);
    await store.pool.query('DELETE FROM ovo_jobs WHERE workspace_id = $1', [workspaceId]);
    await store.close();
  });

  async function enqueue(idempotencyKey: string) {
    const id = randomUUID();
    jobIds.push(id);
    return store.enqueue({ id, workspaceId, idempotencyKey, payload: { fixture: true } });
  }

  it('commits the job and one outbox row transactionally across idempotent enqueue', async () => {
    const first = await enqueue('job-and-outbox-once');
    const duplicate = await store.enqueue({
      id: randomUUID(),
      workspaceId,
      idempotencyKey: 'job-and-outbox-once',
      payload: { fixture: false },
    });
    expect(first.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      job: { id: first.job.id, payload: { fixture: true } },
    });
    const rows = await store.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM ovo_outbox WHERE aggregate_id = $1',
      [first.job.id],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it('gives ten concurrent database claim transactions exactly one epoch owner', async () => {
    const { job } = await enqueue('ten-deliveries');
    const claims = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.claim(job.id, `pg-worker-${index}`, 60_000)),
    );
    const owner = claims.find((claim) => claim !== undefined)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.heartbeat(job.id, owner.ownerId, owner.ownerEpoch - 1, 60_000)).toBe(false);
    expect(await store.heartbeat(job.id, owner.ownerId, owner.ownerEpoch, 60_000)).toBe(true);
  });

  it('persists unknown dial acceptance as reconciliation-only state', async () => {
    const { job } = await enqueue('unknown-dial');
    const owner = await store.claim(job.id, 'pg-worker-dial', 60_000);
    expect(owner).toBeDefined();
    const requestId = `${job.id}:${owner!.ownerEpoch}`;
    expect(await store.beginDial(job.id, owner!.ownerId, owner!.ownerEpoch, requestId)).toBe(true);
    expect(
      await store.markDialUnknown(
        job.id,
        owner!.ownerId,
        owner!.ownerEpoch,
        requestId,
        'timeout-after-write',
      ),
    ).toBe(true);
    expect(await store.get(job.id)).toMatchObject({
      status: 'reconcile_required',
      dialRequestId: requestId,
      lastError: 'timeout-after-write',
    });
  });

  it('fences the desired-count authority to one lease owner and epoch', async () => {
    const serviceKey = `workers-${randomUUID()}`;
    const first = await store.acquire(serviceKey, 'dispatcher-a', 60_000);
    expect(first).toEqual({ epoch: 1 });
    expect(await store.acquire(serviceKey, 'dispatcher-b', 60_000)).toBeUndefined();
    expect(await store.renew(serviceKey, 'dispatcher-a', first!.epoch + 1, 60_000)).toBe(false);
    expect(await store.renew(serviceKey, 'dispatcher-a', first!.epoch, 60_000)).toBe(true);
    await store.pool.query('DELETE FROM ovo_capacity_leases WHERE service_key = $1', [serviceKey]);
  });
});
