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

describe.skipIf(!url)('carrier correlation and session grants', () => {
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

  it('rejects a partially scoped JS correlation instead of broadening it', async () => {
    const { route } = await begin('partial-scope');
    await expect(
      store.resolveSessionRoute({
        organizationId: route.organizationId,
        carrierCallId: 'CA-partial',
      } as RouteLookup),
    ).rejects.toThrow('organizationId and carrierId');
    await expect(
      store.applyCarrierCallback({
        organizationId: route.organizationId,
        provider: 'partial',
        eventId: randomUUID(),
        dialRequestId: route.dialRequestId,
        status: 'ringing',
        occurredAt: new Date(),
      } as CarrierCallbackCorrelationInput),
    ).rejects.toThrow('organizationId and carrierId');
  });

  it('keeps carrier correlation and call-id uniqueness inside organization and carrier', async () => {
    const first = await begin('scope-first');
    const second = await begin('scope-second');
    const third = await begin('scope-third');
    await store.pool.query(
      `UPDATE ovo_session_routes SET organization_id = 'other-org',
         carrier_request_id = $2, dial_request_id = $3 WHERE session_id = $1`,
      [second.route.sessionId, first.route.carrierRequestId, first.route.dialRequestId],
    );
    await store.pool.query(
      `UPDATE ovo_session_routes SET carrier_id = 'other-carrier',
         carrier_request_id = $2, dial_request_id = $3 WHERE session_id = $1`,
      [third.route.sessionId, first.route.carrierRequestId, first.route.dialRequestId],
    );
    expect(
      await scoped.bindCarrierCallId({
        sessionId: first.route.sessionId,
        carrierCallId: 'CA-shared-scope',
        organizationId: first.route.organizationId,
        carrierId: first.route.carrierId,
      }),
    ).toMatchObject({ kind: 'bound' });
    expect(
      await scoped.bindCarrierCallId({
        sessionId: second.route.sessionId,
        carrierCallId: 'CA-shared-scope',
        organizationId: 'other-org',
        carrierId: first.route.carrierId,
      }),
    ).toMatchObject({ kind: 'bound' });
    expect(
      await scoped.bindCarrierCallId({
        sessionId: third.route.sessionId,
        carrierCallId: 'CA-shared-scope',
        organizationId: first.route.organizationId,
        carrierId: 'other-carrier',
      }),
    ).toMatchObject({ kind: 'bound' });
    expect(
      await scoped.resolveSessionRoute({
        carrierCallId: 'CA-shared-scope',
        organizationId: first.route.organizationId,
        carrierId: first.route.carrierId,
      }),
    ).toMatchObject({ sessionId: first.route.sessionId });
    expect(
      await scoped.resolveSessionRoute({
        carrierRequestId: first.route.carrierRequestId,
        organizationId: 'other-org',
        carrierId: first.route.carrierId,
      }),
    ).toMatchObject({ sessionId: second.route.sessionId });
    expect(
      await scoped.resolveSessionRoute({
        carrierCallId: 'CA-shared-scope',
        organizationId: first.route.organizationId,
        carrierId: 'other-carrier',
      }),
    ).toMatchObject({ sessionId: third.route.sessionId });
    expect(await store.findCarrierCallId(first.route.dialRequestId)).toBeUndefined();
    for (const expected of [
      {
        route: first.route,
        organizationId: first.route.organizationId,
        carrierId: first.route.carrierId!,
      },
      { route: second.route, organizationId: 'other-org', carrierId: first.route.carrierId! },
      {
        route: third.route,
        organizationId: first.route.organizationId,
        carrierId: 'other-carrier',
      },
    ]) {
      expect(
        await scoped.applyCarrierCallback({
          organizationId: expected.organizationId,
          carrierId: expected.carrierId,
          provider: 'same-provider',
          eventId: 'same-event',
          carrierCallId: 'CA-shared-scope',
          status: 'ringing',
          occurredAt: new Date(),
        }),
      ).toMatchObject({ kind: 'applied', route: { sessionId: expected.route.sessionId } });
    }
    expect(
      await scoped.issueStreamGrant({
        carrierRequestId: first.route.carrierRequestId,
        organizationId: first.route.organizationId,
        carrierId: 'unknown-carrier',
        tokenHash: createHash('sha256').update('wrong-scope').digest('hex'),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBeUndefined();
  });

  it('records a scoped carrier.call_id_mismatch audit event for a bound stream alias', async () => {
    const { route } = await begin('mismatch-audit');
    await scoped.bindCarrierCallId({ sessionId: route.sessionId, carrierCallId: 'CA-dial-audit' });
    await scoped.bindCarrierCallId({
      sessionId: route.sessionId,
      carrierCallId: 'CA-stream-audit',
    });
    await store.recordCarrierCallIdMismatch({
      sessionId: route.sessionId,
      organizationId: route.organizationId,
      carrierId: route.carrierId!,
      dialCallId: 'CA-dial-audit',
      streamCallId: 'CA-stream-audit',
    });
    expect(
      (
        await store.pool.query(
          `SELECT event_type, organization_id, carrier_id, dial_call_id, stream_call_id
         FROM ovo_orch_audit_events WHERE session_id = $1`,
          [route.sessionId],
        )
      ).rows,
    ).toEqual([
      {
        event_type: 'carrier.call_id_mismatch',
        organization_id: route.organizationId,
        carrier_id: route.carrierId,
        dial_call_id: 'CA-dial-audit',
        stream_call_id: 'CA-stream-audit',
      },
    ]);
  });

  it('rejects a stream call-id mismatch under the grant lock when the carrier promises matching ids', async () => {
    const { route, jobId, owner } = await begin('matching-id-fence');
    expect(
      await store.markDialAccepted({
        jobId,
        workerId: owner.ownerId,
        ownerEpoch: owner.ownerEpoch,
        dialRequestId: route.dialRequestId,
        carrierCallId: 'CA-dial-matching',
      }),
    ).toBe(true);
    const candidate = {
      dialRequestId: route.dialRequestId,
      carrierCallId: 'CA-other-stream',
      streamCallIdMatchesDial: true,
      tokenHash: createHash('sha256').update('matching-id-fence').digest('hex'),
      expiresAt: new Date(Date.now() + 60_000),
    };
    expect(await scoped.issueStreamGrant(candidate)).toBeUndefined();
    expect(await store.getSessionRoute(jobId)).toMatchObject({
      carrierCallId: 'CA-dial-matching',
      carrierStreamCallId: undefined,
    });
    expect(
      await scoped.issueStreamGrant({ ...candidate, streamCallIdMatchesDial: false }),
    ).toMatchObject({ carrierStreamCallId: 'CA-other-stream' });
  });

  it('rejects gateway authentication when the worker slot incarnation, state, or lease changes', async () => {
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 400,
      leaseMs: 60_000,
    });
    const replaced = await begin('auth-replaced-slot');
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 401,
      leaseMs: 60_000,
    });
    expect(
      await store.authenticateSessionRoute(replaced.route.sessionId, replaced.token),
    ).toBeUndefined();

    const expired = await begin('auth-expired-slot');
    await store.pool.query(
      `UPDATE ovo_worker_slots SET lease_expires_at = now() - interval '1 second'
       WHERE worker_id = 'carrier-worker'`,
    );
    expect(
      await store.authenticateSessionRoute(expired.route.sessionId, expired.token),
    ).toBeUndefined();

    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'active',
      ownershipEpoch: 401,
      leaseMs: 60_000,
    });
    const draining = await begin('auth-draining-slot');
    await store.reportWorker({
      workerId: 'carrier-worker',
      state: 'draining',
      ownershipEpoch: 401,
      leaseMs: 60_000,
    });
    expect(
      await store.authenticateSessionRoute(draining.route.sessionId, draining.token),
    ).toBeUndefined();
  });
});
