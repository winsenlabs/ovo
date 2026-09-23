import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import migration001 from '../migrations/001_durable_orchestration.sql?raw';
import migration002 from '../migrations/002_session_lifecycle.sql?raw';
import { PostgresOrchestrationStore } from '../src/postgres.ts';
import type {
  BindCarrierCallInput,
  CarrierCallbackCorrelationInput,
  IssueStreamGrantInput,
  ReissueStreamInput,
  RouteLookup,
} from '../src/types.ts';
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

  it('adopts a populated pre-ledger schema, runs 003, and reruns without rewriting old rows', async () => {
    await store.pool.query(migration001);
    await store.pool.query(migration002);
    const id = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
         owner_id, owner_epoch, lease_expires_at)
       VALUES ($1, $2, 'legacy', '{}'::jsonb, 'connected', 'pre-upgrade-worker', 1,
         now() + interval '1 minute')`,
      [id, schema],
    );
    await store.pool.query(
      `INSERT INTO ovo_worker_slots (worker_id, state, ownership_epoch, observed_at, lease_expires_at)
       VALUES ('pre-upgrade-worker', 'active', 23, now(), now() + interval '1 minute')`,
    );
    const legacySessionId = randomUUID();
    await store.pool.query(
      `INSERT INTO ovo_session_routes (session_id, job_id, organization_id, worker_id,
         worker_endpoint, owner_epoch, generation, dial_request_id, status,
         handshake_token_hash, handshake_expires_at)
       VALUES ($1, $2, $3, 'pre-upgrade-worker', 'ws://127.0.0.1/internal/media',
         1, 1, 'legacy-dial', 'connected', $4, now() + interval '1 minute')`,
      [legacySessionId, id, schema, createHash('sha256').update('legacy').digest('hex')],
    );
    await store.migrate();
    expect(
      (await store.pool.query('SELECT version FROM ovo_orch_schema_migrations ORDER BY version'))
        .rows,
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
    expect(
      (await store.pool.query('SELECT carrier_id, payload FROM ovo_jobs WHERE id = $1', [id]))
        .rows[0],
    ).toMatchObject({ carrier_id: 'twilio', payload: {} });
    expect(
      (
        await store.pool.query(
          'SELECT worker_slot_epoch FROM ovo_session_routes WHERE session_id = $1',
          [legacySessionId],
        )
      ).rows[0]?.worker_slot_epoch,
    ).toBe('23');
    await store.pool
      .query(`UPDATE ovo_worker_slots SET lease_expires_at = now() - interval '1 second'
      WHERE worker_id = 'pre-upgrade-worker'`);
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
            ? scoped.issueStreamGrant({
                dialRequestId: route.dialRequestId,
                carrierCallId: `CA-lock-${method}`,
                tokenHash: createHash('sha256').update(method).digest('hex'),
                expiresAt: new Date(Date.now() + 60_000),
              })
            : method === 'bind'
              ? scoped.bindCarrierCallId({
                  sessionId: route.sessionId,
                  carrierCallId: `CA-lock-${method}`,
                })
              : scoped.applyCarrierCallback({
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
      await scoped.bindCarrierCallId({ sessionId: route.sessionId, carrierCallId: 'CA-primary' }),
    ).toMatchObject({ kind: 'bound', route: { carrierCallId: 'CA-primary' } });
    expect(
      await scoped.bindCarrierCallId({
        dialRequestId: route.dialRequestId,
        carrierCallId: 'CA-stream',
      }),
    ).toMatchObject({ kind: 'alias', route: { carrierStreamCallId: 'CA-stream' } });
    expect(await scoped.resolveSessionRoute({ carrierCallId: 'CA-stream' })).toMatchObject({
      sessionId: route.sessionId,
    });
    expect(
      await scoped.resolveSessionRoute({ carrierRequestId: route.carrierRequestId }),
    ).toMatchObject({ sessionId: route.sessionId });
    expect(
      await scoped.bindCarrierCallId({ sessionId: route.sessionId, carrierCallId: 'CA-third' }),
    ).toEqual({ kind: 'conflict' });
    const other = await begin('collision');
    expect(
      await scoped.bindCarrierCallId({
        sessionId: other.route.sessionId,
        carrierCallId: 'CA-primary',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await scoped.resolveSessionRoute({
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'CA-primary',
      }),
    ).toMatchObject({ sessionId: route.sessionId });
    expect(
      await scoped.resolveSessionRoute({
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
    expect(await scoped.issueStreamGrant(grant)).toMatchObject({ sessionId: route.sessionId });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toMatchObject({
      sessionId: route.sessionId,
    });
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toBeUndefined();
    expect(await scoped.issueStreamGrant(grant)).toBeUndefined();
  });

  it('does not issue a grant after the route loses its job lease', async () => {
    const { route, jobId } = await begin('stale-grant');
    await store.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    expect(
      await scoped.issueStreamGrant({
        dialRequestId: route.dialRequestId,
        tokenHash: createHash('sha256').update('stale-grant').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBeUndefined();
  });

  it('does not authenticate a grant after the route loses its job lease', async () => {
    const { route, jobId, token } = await begin('stale-auth');
    await store.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    expect(await store.authenticateSessionRoute(route.sessionId, token)).toBeUndefined();
  });

  it('does not issue a grant from a newer incarnation of the same worker id', async () => {
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 200,
      leaseMs: 60_000,
    });
    const { route } = await begin('stale-slot-grant');
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 201,
      leaseMs: 60_000,
    });
    expect(
      await scoped.issueStreamGrant({
        dialRequestId: route.dialRequestId,
        tokenHash: createHash('sha256').update('stale-slot-grant').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBeUndefined();
  });

  it('fences the exact route after its worker loses ownership', async () => {
    const { route, jobId } = await begin('lost-owner-fence');
    await store.pool.query(
      `UPDATE ovo_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId],
    );
    const replacement = await store.claim(jobId, 'replacement', 60_000);
    expect(replacement.kind).toBe('reconcile');
    if (replacement.kind !== 'reconcile') return;
    expect(replacement.job.ownerEpoch).toBeGreaterThan(route.ownerEpoch);
    expect(await store.requestSessionTermination(route, 'owner_lost')).toMatchObject({
      carrierRequestId: route.carrierRequestId,
    });
    expect(await store.getSessionRoute(jobId)).toMatchObject({ status: 'terminating' });
    expect(
      await scoped.issueStreamGrant({
        dialRequestId: route.dialRequestId,
        tokenHash: createHash('sha256').update('post-reclaim').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBeUndefined();
  });

  it('resolves a request-id-only route when the stream supplies its first call id', async () => {
    const { route, jobId, owner } = await begin('request-only-lookup');
    await store.markDialAccepted({
      jobId,
      workerId: owner.ownerId,
      ownerEpoch: owner.ownerEpoch,
      dialRequestId: route.dialRequestId,
      carrierRequestId: route.carrierRequestId,
    });
    expect(
      await scoped.resolveSessionRoute({
        carrierRequestId: route.carrierRequestId,
        carrierCallId: 'CA-first-stream',
      }),
    ).toMatchObject({ sessionId: route.sessionId, carrierCallId: undefined });
  });
});
