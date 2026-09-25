import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../src/postgres.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('PostgreSQL session lifecycle integration', () => {
  let store: PostgresOrchestrationStore;
  const organizationId = `single-org-${randomUUID()}`;
  const jobIds: string[] = [];

  beforeAll(async () => {
    store = new PostgresOrchestrationStore({ connectionString: postgresUrl });
    await store.migrate();
  });

  afterAll(async () => {
    if (!store) return;
    await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id = ANY($1::uuid[])', [jobIds]);
    await store.pool.query('DELETE FROM ovo_jobs WHERE workspace_id = $1', [organizationId]);
    await store.close();
  });

  async function begin(idempotencyKey: string) {
    await store.reportWorker({
      workerId: 'worker-1',
      state: 'active',
      ownershipEpoch: 1,
      leaseMs: 60_000,
    });
    const jobId = randomUUID();
    jobIds.push(jobId);
    await store.enqueue({ id: jobId, workspaceId: organizationId, idempotencyKey, payload: {} });
    const claim = await store.claim(jobId, 'worker-1', 60_000);
    if (claim.kind !== 'execute') throw new Error('expected execution claim');
    const token = `token-${randomUUID()}`;
    const route = await store.beginDialSession({
      sessionId: randomUUID(),
      jobId,
      organizationId,
      workerId: claim.job.ownerId,
      workerEndpoint: 'ws://10.0.1.20:4100/internal/media',
      ownerEpoch: claim.job.ownerEpoch,
      generation: 1,
      dialRequestId: `${jobId}:${claim.job.ownerEpoch}`,
      handshakeTokenHash: createHash('sha256').update(token).digest('hex'),
      handshakeExpiresAt: new Date(Date.now() + 60_000),
    });
    if (!route) throw new Error('expected route reservation');
    return { jobId, claim: claim.job, route, token };
  }

  it('commits dial intent with a one-time authenticated route before carrier activity', async () => {
    const { jobId, route, token } = await begin('route-before-dial');
    expect(await store.get(jobId)).toMatchObject({
      status: 'dialing',
      dialRequestId: route.dialRequestId,
    });
    expect(await store.authenticateSessionRoute(route.sessionId, 'wrong-token')).toBeUndefined();
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toMatchObject({
      sessionId: route.sessionId,
      workerId: 'worker-1',
      ownerEpoch: route.ownerEpoch,
      generation: 1,
    });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toBeUndefined();
  });

  it('correlates unknown acceptance and never regresses a terminal callback projection', async () => {
    const { jobId, claim, route } = await begin('callback-projection');
    expect(
      await store.markDialUnknown(
        jobId,
        claim.ownerId,
        claim.ownerEpoch,
        route.dialRequestId,
        'timeout-after-carrier-write',
      ),
    ).toBe(true);

    const initiated = await store.applyCarrierCallback({
      provider: 'synthetic',
      eventId: 'event-1',
      dialRequestId: route.dialRequestId,
      carrierCallId: 'CA-session-1',
      status: 'initiated',
      occurredAt: new Date('2026-09-20T14:00:00Z'),
    });
    expect(initiated).toMatchObject({ kind: 'applied', route: { status: 'accepted' } });
    expect(await store.findCarrierCallId(route.dialRequestId)).toBe('CA-session-1');
    expect(
      await store.applyCarrierCallback({
        provider: 'synthetic',
        eventId: 'event-1',
        dialRequestId: route.dialRequestId,
        carrierCallId: 'CA-session-1',
        status: 'initiated',
        occurredAt: new Date('2026-09-20T14:00:00Z'),
      }),
    ).toMatchObject({ kind: 'duplicate' });

    expect(
      await store.applyCarrierCallback({
        provider: 'synthetic',
        eventId: 'event-3',
        carrierCallId: 'CA-session-1',
        status: 'completed',
        occurredAt: new Date('2026-09-20T14:02:00Z'),
      }),
    ).toMatchObject({ kind: 'applied', route: { status: 'completed' } });
    expect(
      await store.applyCarrierCallback({
        provider: 'synthetic',
        eventId: 'event-2-late',
        carrierCallId: 'CA-session-1',
        status: 'answered',
        occurredAt: new Date('2026-09-20T14:01:00Z'),
      }),
    ).toMatchObject({ kind: 'ignored_out_of_order', route: { status: 'completed' } });
    expect(await store.get(jobId)).toMatchObject({
      status: 'completed',
      carrierCallId: 'CA-session-1',
    });
    expect(await store.releaseTerminalSession(jobId)).toBe(true);
    expect(await store.releaseTerminalSession(jobId)).toBe(false);
    expect(await store.getSessionRoute(jobId)).toMatchObject({ releasedAt: expect.any(Date) });
  });

  it('rejects a callback that tries to rebind a correlated request to another carrier call', async () => {
    const { route } = await begin('callback-conflict');
    await store.applyCarrierCallback({
      provider: 'synthetic',
      eventId: 'bind-original',
      dialRequestId: route.dialRequestId,
      carrierCallId: 'CA-original',
      status: 'ringing',
      occurredAt: new Date(),
    });
    expect(
      await store.applyCarrierCallback({
        provider: 'synthetic',
        eventId: 'bind-conflict',
        dialRequestId: route.dialRequestId,
        carrierCallId: 'CA-other',
        status: 'answered',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'correlation_conflict', route: { carrierCallId: 'CA-original' } });
  });

  it('reclaims an expired accepted call only for termination reconciliation', async () => {
    const { jobId, claim, route } = await begin('accepted-owner-loss');
    await store.applyCarrierCallback({
      provider: 'synthetic',
      eventId: 'accepted-before-crash',
      dialRequestId: route.dialRequestId,
      carrierCallId: 'CA-owner-loss',
      status: 'initiated',
      occurredAt: new Date(),
    });
    await store.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );

    const reclaimed = await store.claim(jobId, 'worker-reconciler', 60_000);
    expect(reclaimed.kind).toBe('reconcile');
    if (reclaimed.kind !== 'reconcile') throw new Error('expected reconciliation claim');
    expect(reclaimed.job).toMatchObject({
      status: 'reconcile_required',
      carrierCallId: 'CA-owner-loss',
      ownerEpoch: claim.ownerEpoch + 1,
    });
    expect(await store.getSessionRoute(jobId)).toMatchObject({
      workerId: claim.ownerId,
      ownerEpoch: claim.ownerEpoch,
      generation: 1,
    });
    expect(await store.heartbeat(jobId, claim.ownerId, claim.ownerEpoch, 60_000)).toBe(false);
    expect(
      await store.prepareReconciledTermination(
        jobId,
        reclaimed.job.ownerId,
        reclaimed.job.ownerEpoch,
        route.dialRequestId,
        'CA-owner-loss',
        'owner-lost',
      ),
    ).toBe(true);
    expect(await store.getSessionRoute(jobId)).toMatchObject({ status: 'terminating' });
  });
});
