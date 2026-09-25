import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../src/postgres.ts';
import type {
  BindCarrierCallInput,
  CarrierCallbackCorrelationInput,
  IssueStreamGrantInput,
  ReissueStreamInput,
  RouteLookup,
} from '../src/types.ts';
import { beginRoute } from './carrier-identity-support.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!url)('carrier callback and grant lifecycle', () => {
  const schema = `carrier_identity_${randomUUID().replaceAll('-', '')}`;
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
  });

  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  const begin = (label: string) => beginRoute(store, schema, label);
  const scope = { organizationId: schema, carrierId: 'carrier-test' };
  type PartialScope<T> = Omit<T, 'organizationId' | 'carrierId'> &
    Partial<Pick<BindCarrierCallInput, 'organizationId' | 'carrierId'>>;
  const scoped = {
    resolveSessionRoute(input: PartialScope<RouteLookup>) {
      return store.resolveSessionRoute({ ...scope, ...input });
    },
    bindCarrierCallId(input: PartialScope<BindCarrierCallInput>) {
      return store.bindCarrierCallId({ ...scope, ...input });
    },
    issueStreamGrant(input: PartialScope<IssueStreamGrantInput>) {
      return store.issueStreamGrant({ ...scope, ...input });
    },
    reissueStream(input: PartialScope<ReissueStreamInput>) {
      return store.reissueStream({ ...scope, ...input });
    },
    applyCarrierCallback(input: PartialScope<CarrierCallbackCorrelationInput>) {
      return store.applyCarrierCallback({ ...scope, ...input });
    },
  };

  it('correlates callbacks by request id or a recorded stream alias without accepting a third id', async () => {
    const { route } = await begin('callback-alias');
    expect(
      await scoped.applyCarrierCallback({
        provider: 'carrier-test',
        eventId: randomUUID(),
        carrierRequestId: route.carrierRequestId,
        status: 'ringing',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'applied', route: { status: 'accepted' } });
    await scoped.bindCarrierCallId({
      sessionId: route.sessionId,
      carrierCallId: 'CA-callback-primary',
    });
    await scoped.bindCarrierCallId({
      sessionId: route.sessionId,
      carrierCallId: 'CA-callback-stream',
    });
    expect(
      await scoped.applyCarrierCallback({
        provider: 'carrier-test',
        eventId: randomUUID(),
        carrierCallId: 'CA-callback-stream',
        status: 'answered',
        occurredAt: new Date(),
      }),
    ).toMatchObject({
      kind: 'applied',
      route: { status: 'connected', carrierCallId: 'CA-callback-primary' },
    });
    expect(
      await scoped.applyCarrierCallback({
        provider: 'carrier-test',
        eventId: randomUUID(),
        dialRequestId: route.dialRequestId,
        carrierCallId: 'CA-callback-third',
        status: 'completed',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'correlation_conflict' });
    expect(await store.getSessionRoute(route.jobId)).toMatchObject({ status: 'connected' });
  });

  it('rejects contradictory callback correlation even when one identifier matches', async () => {
    const { route } = await begin('callback-contradiction');
    expect(
      await scoped.applyCarrierCallback({
        provider: 'carrier-test',
        eventId: randomUUID(),
        dialRequestId: route.dialRequestId,
        carrierRequestId: 'wrong-request',
        carrierCallId: 'CA-contradiction',
        status: 'answered',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'correlation_conflict' });
    expect(await store.getSessionRoute(route.jobId)).toMatchObject({
      status: 'dialing',
      carrierCallId: undefined,
    });
  });

  it('does not let acceptance or reconciliation reuse another route’s stream alias', async () => {
    const first = await begin('cross-column-a');
    await scoped.bindCarrierCallId({ sessionId: first.route.sessionId, carrierCallId: 'CA-first' });
    await scoped.bindCarrierCallId({
      sessionId: first.route.sessionId,
      carrierCallId: 'CA-shared-alias',
    });
    const second = await begin('cross-column-b');
    expect(
      await store.markDialAccepted({
        jobId: second.jobId,
        workerId: second.owner.ownerId,
        ownerEpoch: second.owner.ownerEpoch,
        dialRequestId: second.route.dialRequestId,
        carrierCallId: 'CA-shared-alias',
      }),
    ).toBe(false);
    expect(await store.getSessionRoute(second.jobId)).toMatchObject({
      status: 'dialing',
      carrierCallId: undefined,
    });
    await store.markDialUnknown(
      second.jobId,
      second.owner.ownerId,
      second.owner.ownerEpoch,
      second.route.dialRequestId,
      'unknown',
    );
    expect(
      await store.prepareReconciledTermination(
        second.jobId,
        second.owner.ownerId,
        second.owner.ownerEpoch,
        second.route.dialRequestId,
        'CA-shared-alias',
        'reconcile',
      ),
    ).toBe(false);
  });

  it('rejects resume from a newer worker incarnation with the same worker id', async () => {
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 300,
      leaseMs: 60_000,
    });
    const { route, jobId, owner } = await begin('worker-epoch');
    await store.markDialAccepted(
      jobId,
      owner.ownerId,
      owner.ownerEpoch,
      route.dialRequestId,
      'CA-epoch',
    );
    await scoped.applyCarrierCallback({
      provider: 'carrier-test',
      eventId: randomUUID(),
      carrierCallId: 'CA-epoch',
      status: 'answered',
      occurredAt: new Date(),
    });
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 301,
      leaseMs: 60_000,
    });
    expect(
      await scoped.reissueStream({
        carrierCallId: 'CA-epoch',
        tokenHash: createHash('sha256').update('newer-worker').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
        workerFreshSeconds: 30,
      }),
    ).toBeUndefined();
  });

  it('issues one-use grants and rejects any grant after pre-answer termination', async () => {
    const { route, jobId, owner, token } = await begin('terminate');
    const fresh = `fresh-${randomUUID()}`;
    expect(
      await scoped.issueStreamGrant({
        carrierRequestId: route.carrierRequestId,
        tokenHash: createHash('sha256').update(fresh).digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toMatchObject({ sessionId: route.sessionId });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toBeUndefined();
    expect(
      await store.requestSessionTermination(jobId, owner.ownerId, owner.ownerEpoch, 'owner_lost'),
    ).toMatchObject({ carrierRequestId: route.carrierRequestId });
    expect(
      await scoped.issueStreamGrant({
        dialRequestId: route.dialRequestId,
        tokenHash: createHash('sha256').update('late').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBeUndefined();
    expect(await store.authenticateSessionRoute(route.sessionId, fresh)).toBeUndefined();
  });

  it('increments generation only for connected routes with fresh worker and ownership leases', async () => {
    const { route, jobId, owner, token } = await begin('resume');
    await store.markDialAccepted(
      jobId,
      owner.ownerId,
      owner.ownerEpoch,
      route.dialRequestId,
      'CA-resume',
    );
    await scoped.applyCarrierCallback({
      provider: 'carrier-test',
      eventId: randomUUID(),
      carrierCallId: 'CA-resume',
      status: 'answered',
      occurredAt: new Date(),
    });
    await store.reportWorker({
      workerId: owner.ownerId,
      state: 'active',
      ownershipEpoch: owner.ownerEpoch,
      leaseMs: 60_000,
    });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toMatchObject({
      sessionId: route.sessionId,
    });
    const grant = {
      carrierCallId: 'CA-resume',
      tokenHash: createHash('sha256').update('resume').digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
      workerFreshSeconds: 30,
    };
    expect(await scoped.reissueStream(grant)).toMatchObject({ generation: 2, status: 'connected' });
    await store.pool.query(
      `UPDATE ovo_worker_slots SET observed_at = now() - interval '1 minute'
      WHERE worker_id = $1`,
      [owner.ownerId],
    );
    expect(await scoped.reissueStream(grant)).toBeUndefined();
    await store.reportWorker({
      workerId: owner.ownerId,
      state: 'active',
      ownershipEpoch: owner.ownerEpoch,
      leaseMs: 60_000,
    });
    await store.requestSessionTermination(jobId, owner.ownerId, owner.ownerEpoch, 'done');
    expect(await scoped.reissueStream(grant)).toBeUndefined();
  });

  it('counts eligible jobs and fresh idle or busy slots without changing them', async () => {
    await store.enqueue({
      id: randomUUID(),
      workspaceId: schema,
      idempotencyKey: 'snapshot-queued',
      payload: {},
    });
    await store.reportWorker({
      workerId: 'idle-worker',
      state: 'ready_idle',
      ownershipEpoch: 1,
      leaseMs: 60_000,
    });
    const before = await store.pool.query('SELECT count(*)::int AS count FROM ovo_worker_slots');
    const snapshot = await store.admissionSnapshot();
    expect(snapshot.readyIdleSlots).toBe(1);
    expect(snapshot.busySlots).toBe(1);
    expect(snapshot.eligibleQueuedJobs).toBeGreaterThanOrEqual(1);
    expect(
      (await store.pool.query('SELECT count(*)::int AS count FROM ovo_worker_slots')).rows[0],
    ).toEqual(before.rows[0]);
  });
});
