import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/index.ts';
import { effectiveInboundRoute, PostgresOperationsService } from '../src/index.ts';
import { publishedRelease, releaseIds, routingSchema } from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const organizationId = 'org-routed-admission';

/** C3: a number bound to a routing release is admitted to the router release (routing on) or to
 * the release's default agent (routing off, the kill switch); a direct number is unchanged. */
describe.skipIf(!postgresUrl)('routed inbound admission', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let on: PostgresOperationsService;
  let off: PostgresOperationsService;
  let release: Awaited<ReturnType<typeof publishedRelease>>;
  const ids = releaseIds();
  const direct = randomUUID();
  let slot = 0;

  const service = (routingEnabled: boolean) => {
    const operations = new PostgresOperationsService({
      pool: db.pool,
      organizationId,
      config: { liveEnabled: true, permittedFromNumbers: [], routingEnabled },
    });
    operations.inboundGateway.setInstalledCarrierPlugins(
      [{ pluginId: '@winsendotai/ovo-carrier-twilio', carrierId: 'twilio' }],
      'twilio',
    );
    return operations;
  };
  const capacity = () =>
    on.inbound.registerProtectedCapacity({
      slotId: `slot-${++slot}`,
      workerId: `worker-${slot}`,
      workerEndpoint: 'wss://worker.internal.example/session',
      generation: slot,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
  const call = (toNumber: string) => ({
    carrierCallId: `CA${randomUUID().replaceAll('-', '')}`,
    fromNumber: '+14155550100',
    toNumber,
    routeTokenHash: 'a'.repeat(64),
    handshakeTtlMs: 60_000,
  });
  const job = async (jobId: string) =>
    (
      await db.pool.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM ovo_jobs WHERE id = $1',
        [jobId],
      )
    ).rows[0]!.payload;
  const admission = async (admissionId: string) =>
    (
      await db.pool.query<{
        routing_release_id: string | null;
        release_id: string;
        detail: Record<string, unknown>;
      }>(
        'SELECT routing_release_id, release_id, detail FROM ovo_ops_inbound_admissions WHERE id = $1',
        [admissionId],
      )
    ).rows[0]!;

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    await new PostgresOrchestrationStore(db.pool).migrate();
    on = service(true);
    off = service(false);
    await on.migrate();
    release = await publishedRelease(on.routing, ids);
    for (const phoneNumber of ['+14155550101', '+14155550102'])
      await on.inboundRoutes.put({
        phoneNumber,
        routingReleaseId: release.id,
        expectedVersion: null,
      });
    await on.inboundRoutes.put({
      phoneNumber: '+14155550103',
      releaseId: direct,
      expectedVersion: null,
    });
  });

  afterAll(async () => db?.drop());

  const routing = () => ({
    routingReleaseId: release.id,
    routingPointId: release.routingPointId,
    version: 1,
    defaultReleaseId: ids.fallback,
  });

  it('resolves the effective release the gateway pre-check and admission share', async () => {
    expect(
      await effectiveInboundRoute(db.pool, organizationId, '+14155550101', true),
    ).toMatchObject({
      release_id: ids.router,
      routing_release_id: release.id,
      routing: routing(),
      routing_disabled: false,
    });
    expect(
      await effectiveInboundRoute(db.pool, organizationId, '+14155550101', false),
    ).toMatchObject({
      release_id: ids.fallback,
      routing: null,
      routing_disabled: true,
    });
    expect(
      await effectiveInboundRoute(db.pool, organizationId, '+14155550103', true),
    ).toMatchObject({
      release_id: direct,
      routing_release_id: null,
      routing: null,
      routing_disabled: false,
    });
    expect(
      await effectiveInboundRoute(db.pool, organizationId, '+14155559999', true),
    ).toBeUndefined();
  });

  it('admits a routed call to the router release with the routing payload', async () => {
    await capacity();
    const decision = await on.inboundGateway.admit(call('+14155550101'));
    expect(decision).toMatchObject({ kind: 'reserved', releaseId: ids.router });
    if (decision.kind !== 'reserved') return;
    expect(await job(decision.jobId)).toMatchObject({ releaseId: ids.router, routing: routing() });
    expect(await admission(decision.admissionId)).toMatchObject({
      routing_release_id: release.id,
      release_id: ids.router,
      detail: { kind: 'reserved', routingReleaseId: release.id },
    });
    expect(await on.calls.get(decision.jobId)).toMatchObject({ releaseId: ids.router });
  });

  it('with routing off admits the routed number to its default agent', async () => {
    await capacity();
    const decision = await off.inboundGateway.admit(call('+14155550101'));
    expect(decision).toMatchObject({ kind: 'reserved', releaseId: ids.fallback });
    if (decision.kind !== 'reserved') return;
    const payload = await job(decision.jobId);
    expect(payload.releaseId).toBe(ids.fallback);
    expect(payload).not.toHaveProperty('routing');
    expect(await admission(decision.admissionId)).toMatchObject({
      routing_release_id: release.id,
      detail: { routingDisabled: true },
    });
  });

  it('keeps routing across a wait, and applies the kill switch on resume', async () => {
    await db.pool.query(
      'UPDATE ovo_ops_inbound_capacity SET ready = false WHERE organization_id = $1',
      [organizationId],
    );
    await on.inbound.setPolicy(
      { kind: 'wait', maxWaitMs: 30_000, announcement: 'Please wait' },
      null,
    );
    const routed = call('+14155550102');
    const waiting = await on.inboundGateway.admit(routed);
    expect(waiting.kind).toBe('wait');
    expect(await admission(waiting.admissionId)).toMatchObject({ routing_release_id: release.id });
    await capacity();
    const resumed = await on.inboundGateway.admit(routed);
    expect(resumed).toMatchObject({
      kind: 'reserved',
      admissionId: waiting.admissionId,
      releaseId: ids.router,
    });
    if (resumed.kind !== 'reserved') return;
    expect(await job(resumed.jobId)).toMatchObject({ releaseId: ids.router, routing: routing() });

    const killed = call('+14155550102');
    expect((await on.inboundGateway.admit(killed)).kind).toBe('wait');
    await capacity();
    const resumedOff = await off.inboundGateway.admit(killed);
    expect(resumedOff).toMatchObject({ kind: 'reserved', releaseId: ids.fallback });
    if (resumedOff.kind !== 'reserved') return;
    expect(await job(resumedOff.jobId)).not.toHaveProperty('routing');
    expect((await admission(resumedOff.admissionId)).detail).toMatchObject({
      routingDisabled: true,
    });
    await on.inbound.setPolicy({ kind: 'busy', reason: 'at capacity' }, 1);
  });

  it('leaves a direct number exactly as before', async () => {
    await capacity();
    const decision = await on.inboundGateway.admit(call('+14155550103'));
    expect(decision).toMatchObject({ kind: 'reserved', releaseId: direct });
    if (decision.kind !== 'reserved') return;
    const payload = await job(decision.jobId);
    expect(payload.releaseId).toBe(direct);
    expect(payload).not.toHaveProperty('routing');
    const row = await admission(decision.admissionId);
    expect(row.routing_release_id).toBeNull();
    expect(row.detail).toEqual({ kind: 'reserved', releaseId: direct, routeVersion: 1 });
  });

  it('calls a routed number back with only the variables its default agent declares', async () => {
    const callbackNumber = '+14155550104';
    const legacyNumber = '+14155550105';
    const variables = { account: 'A1', router_only: 'x' };
    await on.inboundRoutes.put({
      phoneNumber: callbackNumber,
      routingReleaseId: release.id,
      variables,
      defaultVariablesSchema: {
        type: 'object',
        properties: { account: { type: 'string' } },
        additionalProperties: false,
      },
      expectedVersion: null,
    });
    // Bound before the schema was captured: its variables pass unfiltered, as before.
    await on.inboundRoutes.put({
      phoneNumber: legacyNumber,
      routingReleaseId: release.id,
      variables,
      expectedVersion: null,
    });
    await db.pool.query(
      'UPDATE ovo_ops_inbound_capacity SET ready = false WHERE organization_id = $1',
      [organizationId],
    );
    await on.inbound.setPolicy(
      { kind: 'callback', queue: 'routed-callbacks', announcement: 'We will call back' },
      2,
    );
    const contact = async (routingEnabled: boolean, toNumber: string) => {
      const gateway = new PostgresOperationsService({
        pool: db.pool,
        organizationId,
        config: { liveEnabled: true, permittedFromNumbers: [toNumber], routingEnabled },
      });
      gateway.inboundGateway.setInstalledCarrierPlugins(
        [{ pluginId: '@winsendotai/ovo-carrier-twilio', carrierId: 'twilio' }],
        'twilio',
      );
      const input = call(toNumber);
      expect(await gateway.inboundGateway.admit(input)).toMatchObject({ kind: 'callback' });
      const queued = await gateway.inboundGateway.confirmCallback({ ...input, digits: '1' });
      if (queued.kind !== 'callback' || queued.state !== 'queued') throw new Error('not queued');
      return (
        await db.pool.query<{ variables: Record<string, string>; agent_release_id: string }>(
          `SELECT c.variables, k.agent_release_id FROM ovo_ops_campaign_contacts c
           JOIN ovo_ops_campaigns k ON k.id = c.campaign_id WHERE c.id = $1`,
          [queued.contactId],
        )
      ).rows[0]!;
    };
    expect(await contact(true, callbackNumber)).toEqual({
      variables: { account: 'A1' },
      agent_release_id: ids.fallback,
    });
    expect(await contact(false, callbackNumber)).toEqual({
      variables: { account: 'A1' },
      agent_release_id: ids.fallback,
    });
    expect((await contact(true, legacyNumber)).variables).toEqual(variables);
  });
});
