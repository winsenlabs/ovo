import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import migration001 from '../migrations/001_durable_orchestration.sql?raw';
import migration002 from '../migrations/002_session_lifecycle.sql?raw';
import { PostgresOrchestrationStore } from '../src/postgres.ts';
import { beginRoute, waitForBlockedStore } from './carrier-identity-support.ts';

const url = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!url)('carrier identity migrations and grants', () => {
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
  });

  afterAll(async () => {
    if (store) await store.close();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  const begin = (label: string) => beginRoute(store, schema, label);

  it('adopts a populated pre-ledger schema, runs 003, and reruns without rewriting old rows', async () => {
    await store.pool.query(migration001);
    await store.pool.query(migration002);
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status)
       VALUES ($1, $2, 'legacy', '{}'::jsonb, 'queued')`,
      [id, schema],
    );
    await store.migrate();
    expect(
      (await store.pool.query('SELECT version FROM ovo_orch_schema_migrations ORDER BY version'))
        .rows,
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(
      (await store.pool.query('SELECT carrier_id, payload FROM ovo_jobs WHERE id = $1', [id]))
        .rows[0],
    ).toMatchObject({ carrier_id: 'twilio', payload: {} });
    await store.migrate();
    expect(
      (await store.pool.query('SELECT count(*)::int AS count FROM ovo_jobs WHERE id = $1', [id]))
        .rows[0]?.count,
    ).toBe(1);
  });

  it.each(['grant', 'bind', 'callback'] as const)(
    'takes the job lock before the route lock during %s',
    async (method) => {
      const { route } = await begin(`lock-${method}`);
      const blocker = await store.pool.connect();
      let pending: Promise<unknown> | undefined;
      let routeLockAcquired = false;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM ovo_jobs WHERE id = $1 FOR UPDATE', [route.jobId]);
        pending =
          method === 'grant'
            ? store.issueStreamGrant({
                dialRequestId: route.dialRequestId,
                carrierCallId: `CA-lock-${method}`,
                tokenHash: createHash('sha256').update(method).digest('hex'),
                expiresAt: new Date(Date.now() + 60_000),
              })
            : method === 'bind'
              ? store.bindCarrierCallId({
                  sessionId: route.sessionId,
                  carrierCallId: `CA-lock-${method}`,
                })
              : store.applyCarrierCallback({
                  provider: 'carrier-test',
                  eventId: randomUUID(),
                  dialRequestId: route.dialRequestId,
                  carrierCallId: `CA-lock-${method}`,
                  status: 'answered',
                  occurredAt: new Date(),
                });
        await waitForBlockedStore(admin, schema);
        try {
          await blocker.query(
            'SELECT session_id FROM ovo_session_routes WHERE session_id = $1 FOR UPDATE NOWAIT',
            [route.sessionId],
          );
          routeLockAcquired = true;
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('could not obtain lock'))
            throw error;
        }
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending;
      }
      expect(routeLockAcquired).toBe(true);
    },
  );

  it('accepts request-only dials, binds call id and alias once, and rejects a third id', async () => {
    const { route, jobId, owner } = await begin('alias');
    expect(
      await store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
        carrierRequestId: route.carrierRequestId,
      }),
    ).toBe(true);
    expect(
      await store.bindCarrierCallId({ sessionId: route.sessionId, carrierCallId: 'CA-primary' }),
    ).toMatchObject({ kind: 'bound', route: { carrierCallId: 'CA-primary' } });
    expect(
      await store.bindCarrierCallId({
        dialRequestId: route.dialRequestId,
        carrierCallId: 'CA-stream',
      }),
    ).toMatchObject({ kind: 'alias', route: { carrierStreamCallId: 'CA-stream' } });
    expect(await store.resolveSessionRoute({ carrierCallId: 'CA-stream' })).toMatchObject({
      sessionId: route.sessionId,
    });
    expect(
      await store.resolveSessionRoute({ carrierRequestId: route.carrierRequestId }),
    ).toMatchObject({ sessionId: route.sessionId });
    expect(
      await store.bindCarrierCallId({ sessionId: route.sessionId, carrierCallId: 'CA-third' }),
    ).toEqual({ kind: 'conflict' });
    const other = await begin('collision');
    expect(
      await store.bindCarrierCallId({
        sessionId: other.route.sessionId,
        carrierCallId: 'CA-primary',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await store.resolveSessionRoute({
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'CA-primary',
      }),
    ).toMatchObject({ sessionId: route.sessionId });
    expect(
      await store.resolveSessionRoute({
        carrierRequestId: other.route.carrierRequestId,
        carrierCallId: 'CA-primary',
      }),
    ).toBeUndefined();
  });

  it('requires a carrier identity and permits exactly one handshake per grant', async () => {
    const { route, jobId, owner } = await begin('one-use');
    await expect(
      store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
      }),
    ).rejects.toThrow('requires a carrier call or request id');
    const token = `grant-${randomUUID()}`;
    const grant = {
      dialRequestId: route.dialRequestId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await store.issueStreamGrant(grant)).toMatchObject({ sessionId: route.sessionId });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toMatchObject({
      sessionId: route.sessionId,
    });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toBeUndefined();
    expect(await store.issueStreamGrant(grant)).toBeUndefined();
  });

  it('correlates callbacks by request id or a recorded stream alias without accepting a third id', async () => {
    const { route } = await begin('callback-alias');
    expect(
      await store.applyCarrierCallback({
        provider: 'carrier-test',
        eventId: randomUUID(),
        carrierRequestId: route.carrierRequestId,
        status: 'ringing',
        occurredAt: new Date(),
      }),
    ).toMatchObject({ kind: 'applied', route: { status: 'accepted' } });
    await store.bindCarrierCallId({
      sessionId: route.sessionId,
      carrierCallId: 'CA-callback-primary',
    });
    await store.bindCarrierCallId({
      sessionId: route.sessionId,
      carrierCallId: 'CA-callback-stream',
    });
    expect(
      await store.applyCarrierCallback({
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
      await store.applyCarrierCallback({
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
      await store.applyCarrierCallback({
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
    await store.bindCarrierCallId({ sessionId: first.route.sessionId, carrierCallId: 'CA-first' });
    await store.bindCarrierCallId({
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
      ownershipEpoch: 100,
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
    await store.applyCarrierCallback({
      provider: 'carrier-test',
      eventId: randomUUID(),
      carrierCallId: 'CA-epoch',
      status: 'answered',
      occurredAt: new Date(),
    });
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 101,
      leaseMs: 60_000,
    });
    expect(
      await store.reissueStream({
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
      await store.issueStreamGrant({
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
      await store.issueStreamGrant({
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
    await store.applyCarrierCallback({
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
    expect(await store.reissueStream(grant)).toMatchObject({ generation: 2, status: 'connected' });
    await store.pool.query(
      `UPDATE ovo_worker_slots SET observed_at = now() - interval '1 minute'
      WHERE worker_id = $1`,
      [owner.ownerId],
    );
    expect(await store.reissueStream(grant)).toBeUndefined();
    await store.reportWorker({
      workerId: owner.ownerId,
      state: 'active',
      ownershipEpoch: owner.ownerEpoch,
      leaseMs: 60_000,
    });
    await store.requestSessionTermination(jobId, owner.ownerId, owner.ownerEpoch, 'done');
    expect(await store.reissueStream(grant)).toBeUndefined();
  });

  it('counts eligible jobs and fresh idle or busy slots without changing them', async () => {
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
