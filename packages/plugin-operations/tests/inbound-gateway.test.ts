import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/index.ts';
import { InboundGatewayAdmissionService, PostgresOperationsService } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('durable inbound gateway admission', () => {
  const organizationId = `inbound-${randomUUID()}`;
  const releaseId = randomUUID();
  const toNumber = '+14155550190';
  const noCapacityNumber = '+14155550192';
  const pool = new Pool({ connectionString: postgresUrl, max: 4 });
  const orchestration = new PostgresOrchestrationStore(pool);
  const operations = new PostgresOperationsService({
    pool,
    organizationId,
    config: { liveEnabled: true, permittedFromNumbers: [toNumber, noCapacityNumber] },
  });

  beforeAll(async () => {
    await orchestration.migrate();
    await operations.migrate();
    operations.inboundGateway.setInstalledCarrierPlugins(
      [{ pluginId: '@winsendotai/ovo-carrier-twilio', carrierId: 'twilio' }],
      'twilio',
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM ovo_session_routes WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM ovo_jobs WHERE workspace_id = $1', [organizationId]);
    await pool.query('DELETE FROM ovo_ops_call_bindings WHERE organization_id = $1', [
      organizationId,
    ]);
    await pool.query('DELETE FROM ovo_ops_inbound_admissions WHERE organization_id = $1', [
      organizationId,
    ]);
    await pool.query(
      `DELETE FROM ovo_ops_outbox WHERE payload->>'campaignId' IN
       (SELECT id::text FROM ovo_ops_campaigns WHERE organization_id = $1)`,
      [organizationId],
    );
    await pool.query('DELETE FROM ovo_ops_campaigns WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM ovo_ops_inbound_capacity WHERE organization_id = $1', [
      organizationId,
    ]);
    await pool.query('DELETE FROM ovo_ops_inbound_policy WHERE organization_id = $1', [
      organizationId,
    ]);
    await pool.query('DELETE FROM ovo_ops_inbound_routes WHERE organization_id = $1', [
      organizationId,
    ]);
    await pool.end();
  });

  it('snapshots the configured release and atomically provisions an accepted incoming session', async () => {
    const route = await operations.inboundRoutes.put({
      phoneNumber: toNumber,
      releaseId,
      variables: { greeting: 'support' },
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      carrierBindingId: 'inbound-main',
      expectedVersion: null,
    });
    expect(route).toMatchObject({
      releaseId,
      version: 1,
      enabled: true,
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      carrierBindingId: 'inbound-main',
    });
    expect(await operations.inboundRoutes.get(toNumber)).toMatchObject({
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      carrierBindingId: 'inbound-main',
    });
    await operations.migrate();
    expect(await operations.inboundRoutes.get(toNumber)).toMatchObject({
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      carrierBindingId: 'inbound-main',
    });
    await operations.inbound.setPolicy({ kind: 'busy', reason: 'at capacity' }, null);
    await operations.inbound.registerProtectedCapacity({
      slotId: `slot-${randomUUID()}`,
      workerId: 'worker-inbound',
      workerEndpoint: 'wss://worker.internal.example/session',
      generation: 17,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
    const input = {
      carrierCallId: `CA${'1'.repeat(32)}`,
      fromNumber: '+14155550191',
      toNumber,
      routeTokenHash: 'a'.repeat(64),
      handshakeTtlMs: 60_000,
    };
    const accepted = await operations.inboundGateway.admit(input);
    expect(accepted).toMatchObject({
      kind: 'reserved',
      workerId: 'worker-inbound',
      releaseId,
      routeVersion: 1,
    });
    if (accepted.kind !== 'reserved') return;
    expect(await operations.inboundGateway.admit(input)).toEqual(accepted);
    expect(
      await operations.inboundRoutes.put({
        phoneNumber: toNumber,
        releaseId,
        expectedVersion: 1,
      }),
    ).toMatchObject({
      version: 2,
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      carrierBindingId: 'inbound-main',
    });

    const job = await pool.query<{
      status: string;
      owner_id: string;
      carrier_call_id: string;
      carrier_plugin_id: string | null;
      carrier_binding_id: string | null;
      binding_id: string | null;
      payload: Record<string, unknown>;
    }>(
      'SELECT status, owner_id, carrier_call_id, carrier_plugin_id, carrier_binding_id, binding_id, payload FROM ovo_jobs WHERE id = $1',
      [accepted.jobId],
    );
    expect(job.rows[0]).toMatchObject({
      status: 'accepted',
      owner_id: 'worker-inbound',
      carrier_call_id: input.carrierCallId,
      carrier_plugin_id: '@winsendotai/ovo-carrier-twilio',
      carrier_binding_id: 'inbound-main',
      binding_id: 'inbound-main',
      payload: {
        kind: 'inbound_call',
        releaseId,
        variables: { greeting: 'support' },
        carrierCallId: input.carrierCallId,
        carrierPluginId: '@winsendotai/ovo-carrier-twilio',
        carrierBindingId: 'inbound-main',
      },
    });
    const session = await pool.query<{
      status: string;
      handshake_token_hash: string;
      carrier_call_id: string;
      carrier_plugin_id: string | null;
      carrier_binding_id: string | null;
      binding_id: string | null;
    }>(
      'SELECT status, handshake_token_hash, carrier_call_id, carrier_plugin_id, carrier_binding_id, binding_id FROM ovo_session_routes WHERE session_id = $1',
      [accepted.sessionId],
    );
    expect(session.rows[0]).toEqual({
      status: 'accepted',
      handshake_token_hash: input.routeTokenHash,
      carrier_call_id: input.carrierCallId,
      carrier_plugin_id: '@winsendotai/ovo-carrier-twilio',
      carrier_binding_id: 'inbound-main',
      binding_id: 'inbound-main',
    });
    expect(await operations.calls.get(accepted.jobId)).toMatchObject({
      carrierCallId: input.carrierCallId,
      releaseId,
      status: 'active',
    });
    expect(
      await pool.query("SELECT 1 FROM ovo_outbox WHERE payload->>'jobId' = $1", [accepted.jobId]),
    ).toMatchObject({ rowCount: 0 });
    expect(await operations.inbound.releaseByCarrierCallId(input.carrierCallId)).toBe(true);
    expect(await operations.inbound.readyProtectedCapacity()).toBe(1);
  });

  it('durably polls wait calls, expires them explicitly, and queues one consented callback', async () => {
    await pool.query(
      'UPDATE ovo_ops_inbound_capacity SET ready = false WHERE organization_id = $1',
      [organizationId],
    );
    await operations.inboundRoutes.put({
      phoneNumber: noCapacityNumber,
      releaseId,
      expectedVersion: null,
    });
    await operations.inbound.setPolicy(
      { kind: 'wait', maxWaitMs: 30_000, announcement: 'Please wait' },
      1,
    );
    const waitingInput = {
      carrierCallId: `CA${'2'.repeat(32)}`,
      fromNumber: '+14155550193',
      toNumber: noCapacityNumber,
      routeTokenHash: 'b'.repeat(64),
      handshakeTtlMs: 60_000,
    };
    const waiting = await operations.inboundGateway.admit(waitingInput);
    expect(waiting).toMatchObject({ kind: 'wait', announcement: 'Please wait' });
    expect(await operations.inboundGateway.admit(waitingInput)).toEqual(waiting);

    await operations.inbound.registerProtectedCapacity({
      slotId: `wait-slot-${randomUUID()}`,
      workerId: 'worker-after-wait',
      workerEndpoint: 'wss://worker.internal.example/wait-session',
      generation: 18,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
    const acceptedAfterWait = await operations.inboundGateway.admit(waitingInput);
    expect(acceptedAfterWait).toMatchObject({
      kind: 'reserved',
      admissionId: waiting.admissionId,
      workerId: 'worker-after-wait',
      releaseId,
    });
    expect(await operations.inboundGateway.admit(waitingInput)).toEqual(acceptedAfterWait);

    await pool.query(
      'UPDATE ovo_ops_inbound_capacity SET ready = false WHERE organization_id = $1',
      [organizationId],
    );
    const expiringInput = {
      ...waitingInput,
      carrierCallId: `CA${'3'.repeat(32)}`,
      fromNumber: '+14155550194',
      routeTokenHash: 'c'.repeat(64),
    };
    const expiring = await operations.inboundGateway.admit(expiringInput);
    expect(expiring.kind).toBe('wait');
    await pool.query(
      "UPDATE ovo_ops_inbound_admissions SET wait_expires_at = now() - interval '1 second' WHERE id = $1",
      [expiring.admissionId],
    );
    expect(await operations.inboundGateway.admit(expiringInput)).toMatchObject({
      kind: 'busy',
      admissionId: expiring.admissionId,
      reason: 'wait_expired',
    });

    await operations.inbound.setPolicy(
      { kind: 'callback', queue: 'support-callbacks', announcement: 'We will call back' },
      2,
    );
    const unconfiguredGateway = new InboundGatewayAdmissionService(pool, organizationId);
    unconfiguredGateway.setInstalledCarrierPlugins(
      [{ pluginId: '@winsendotai/ovo-carrier-twilio', carrierId: 'twilio' }],
      'twilio',
    );
    const unconfiguredCallback = await unconfiguredGateway.admit({
      carrierCallId: `CA${'4'.repeat(32)}`,
      fromNumber: '+14155550195',
      toNumber: noCapacityNumber,
      routeTokenHash: 'd'.repeat(64),
      handshakeTtlMs: 60_000,
    });
    expect(unconfiguredCallback).toMatchObject({
      kind: 'busy',
      reason: 'callback_outbound_not_configured',
    });
    const callbackInput = {
      carrierCallId: `CA${'5'.repeat(32)}`,
      fromNumber: '+14155550196',
      toNumber: noCapacityNumber,
      routeTokenHash: 'e'.repeat(64),
      handshakeTtlMs: 60_000,
    };
    const callback = await operations.inboundGateway.admit(callbackInput);
    expect(callback).toMatchObject({
      kind: 'callback',
      state: 'prompt',
      announcement: 'We will call back',
    });
    const [queued, queuedRetry] = await Promise.all([
      operations.inboundGateway.confirmCallback({ ...callbackInput, digits: '1' }),
      operations.inboundGateway.confirmCallback({ ...callbackInput, digits: '1' }),
    ]);
    expect(queued).toMatchObject({
      kind: 'callback',
      admissionId: callback.admissionId,
      state: 'queued',
      campaignId: expect.any(String),
      contactId: expect.any(String),
      jobId: expect.any(String),
    });
    expect(queuedRetry).toEqual(queued);
    if (queued.kind !== 'callback' || queued.state !== 'queued') return;
    const durableCallback = await pool.query<{
      campaign_count: string;
      contact_count: string;
      outbox_count: string;
      release_id: string;
      phone_number: string;
      max_attempts_total: number;
      max_attempts_per_local_day: number;
      per_number_attempt_limit: number;
    }>(
      `SELECT
         (SELECT count(*)::text FROM ovo_ops_campaigns WHERE id = $1) AS campaign_count,
         (SELECT count(*)::text FROM ovo_ops_campaign_contacts WHERE id = $2) AS contact_count,
         (SELECT count(*)::text FROM ovo_ops_outbox WHERE aggregate_id = $3) AS outbox_count,
         (SELECT agent_release_id FROM ovo_ops_campaigns WHERE id = $1) AS release_id,
         (SELECT phone_number FROM ovo_ops_campaign_contacts WHERE id = $2) AS phone_number,
         (SELECT max_attempts_total FROM ovo_ops_campaigns WHERE id = $1) AS max_attempts_total,
         (SELECT max_attempts_per_local_day FROM ovo_ops_campaigns WHERE id = $1) AS max_attempts_per_local_day,
         (SELECT per_number_attempt_limit FROM ovo_ops_campaigns WHERE id = $1) AS per_number_attempt_limit`,
      [queued.campaignId, queued.contactId, queued.jobId],
    );
    expect(durableCallback.rows[0]).toEqual({
      campaign_count: '1',
      contact_count: '1',
      outbox_count: '1',
      release_id: releaseId,
      phone_number: callbackInput.fromNumber,
      max_attempts_total: 1,
      max_attempts_per_local_day: 1,
      per_number_attempt_limit: 1,
    });

    const suppressedNumber = '+14155550198';
    await operations.campaigns.suppress(suppressedNumber, 'operator suppression');
    const suppressedInput = {
      ...callbackInput,
      carrierCallId: `CA${'6'.repeat(32)}`,
      fromNumber: suppressedNumber,
      routeTokenHash: 'f'.repeat(64),
    };
    const suppressedPrompt = await operations.inboundGateway.admit(suppressedInput);
    const suppressedCallback = await operations.inboundGateway.confirmCallback({
      ...suppressedInput,
      digits: '1',
    });
    expect(suppressedCallback).toMatchObject({
      kind: 'callback',
      admissionId: suppressedPrompt.admissionId,
      state: 'suppressed',
    });
    const suppressedOutbox = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ovo_ops_outbox o
       JOIN ovo_ops_inbound_admissions a ON a.callback_campaign_id = (o.payload->>'campaignId')::uuid
       WHERE a.id = $1`,
      [suppressedPrompt.admissionId],
    );
    expect(suppressedOutbox.rows[0]?.count).toBe('0');

    await operations.inbound.setPolicy(
      { kind: 'human', target: '+14155550999', announcement: 'Connecting to support' },
      3,
    );
    const human = await operations.inboundGateway.admit({
      carrierCallId: `CA${'7'.repeat(32)}`,
      fromNumber: '+14155550199',
      toNumber: noCapacityNumber,
      routeTokenHash: '7'.repeat(64),
      handshakeTtlMs: 60_000,
    });
    expect(human).toEqual(
      expect.objectContaining({
        kind: 'human',
        target: '+14155550999',
        announcement: 'Connecting to support',
      }),
    );
  });
});
