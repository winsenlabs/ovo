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

  async function beginDial(
    jobId: string,
    owner: { ownerId: string; ownerEpoch: number },
    requestId: string,
  ) {
    return store.beginDialSession({
      sessionId: randomUUID(),
      jobId,
      organizationId: workspaceId,
      workerId: owner.ownerId,
      workerEndpoint: 'ws://worker.test:4100/internal/media',
      ownerEpoch: owner.ownerEpoch,
      generation: 1,
      dialRequestId: requestId,
      handshakeTokenHash: 'test-token-hash',
      handshakeExpiresAt: new Date(Date.now() + 60_000),
    });
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
    const owned = claims.filter((claim) => claim.kind === 'execute');
    expect(owned).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'defer')).toHaveLength(9);
    const owner = owned[0]!.job;
    expect(await store.heartbeat(job.id, owner.ownerId, owner.ownerEpoch - 1, 60_000)).toBe(false);
    expect(await store.heartbeat(job.id, owner.ownerId, owner.ownerEpoch, 60_000)).toBe(true);
  });

  it('persists unknown dial acceptance as reconciliation-only state', async () => {
    const { job } = await enqueue('unknown-dial');
    const claim = await store.claim(job.id, 'pg-worker-dial', 60_000);
    expect(claim.kind).toBe('execute');
    if (claim.kind !== 'execute') throw new Error('expected execution ownership');
    const owner = claim.job;
    const requestId = `${job.id}:${owner.ownerEpoch}`;
    expect(await beginDial(job.id, owner, requestId)).toBeDefined();
    expect(
      await store.markDialUnknown(
        job.id,
        owner.ownerId,
        owner.ownerEpoch,
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

  it('reclaims an expired crash-left dial only for reconciliation and fences the stale owner', async () => {
    const { job } = await enqueue('crash-left-dialing');
    const first = await store.claim(job.id, 'crashed-worker', 60_000);
    expect(first.kind).toBe('execute');
    if (first.kind !== 'execute') throw new Error('expected first execution owner');
    const requestId = `${job.id}:${first.job.ownerEpoch}`;
    expect(await beginDial(job.id, first.job, requestId)).toBeDefined();

    const leased = await store.claim(job.id, 'early-reconciler', 60_000);
    expect(leased).toMatchObject({ kind: 'defer', reason: 'currently_leased' });
    await store.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [job.id],
    );

    const reclaimed = await store.claim(job.id, 'reconciler', 60_000);
    expect(reclaimed.kind).toBe('reconcile');
    if (reclaimed.kind !== 'reconcile') throw new Error('expected reconciliation ownership');
    expect(reclaimed.job).toMatchObject({
      status: 'reconcile_required',
      dialRequestId: requestId,
      ownerEpoch: first.job.ownerEpoch + 1,
    });
    expect(
      await store.markDialAccepted(
        job.id,
        first.job.ownerId,
        first.job.ownerEpoch,
        requestId,
        'CA-stale',
      ),
    ).toBe(false);
    expect(
      await store.markDialAccepted(
        job.id,
        reclaimed.job.ownerId,
        reclaimed.job.ownerEpoch,
        requestId,
        'CA-reconciled',
      ),
    ).toBe(true);
    expect(await store.get(job.id)).toMatchObject({
      status: 'accepted',
      dialRequestId: requestId,
      carrierCallId: 'CA-reconciled',
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
