import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/index.ts';
import { PostgresOperationsService } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const hash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * OBS-8: inbound admission left the worker's slot ready_idle until the worker's next report (up to
 * 5 s). A stream that dropped in that window could not resume, and outbound admission counted the
 * slot as idle. Admission now reserves the slot in its own transaction.
 */
describe.skipIf(!postgresUrl)('inbound admission reserves the worker slot (OBS-8)', () => {
  const organizationId = `obs8-${randomUUID()}`;
  const workerId = `worker-${randomUUID()}`;
  const epoch = 23;
  const pool = new Pool({ connectionString: postgresUrl, max: 4 });
  const orchestration = new PostgresOrchestrationStore(pool);
  const operations = new PostgresOperationsService({
    pool,
    organizationId,
    config: { liveEnabled: true, permittedFromNumbers: [] },
  });
  let number = 0;

  const slotState = async () =>
    (
      await pool.query<{ state: string }>(
        'SELECT state FROM ovo_worker_slots WHERE worker_id = $1',
        [workerId],
      )
    ).rows[0]?.state;
  const report = (state: 'ready_idle' | 'active') =>
    orchestration.reportWorker({ workerId, state, ownershipEpoch: epoch, leaseMs: 15_000 });

  async function admit(token = 'route-token') {
    const toNumber = `+1415555${String(1000 + ++number)}`;
    await operations.inboundRoutes.put({
      phoneNumber: toNumber,
      releaseId: randomUUID(),
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      expectedVersion: null,
    });
    await operations.inbound.registerProtectedCapacity({
      slotId: `slot-${workerId}`,
      workerId,
      workerEndpoint: 'wss://worker.internal.example/session',
      generation: epoch,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
    await report('ready_idle');
    const input = {
      carrierCallId: `CA${randomUUID().replaceAll('-', '')}`,
      fromNumber: '+14155550100',
      toNumber,
      routeTokenHash: hash(token),
      handshakeTtlMs: 60_000,
    };
    const decision = await operations.inboundGateway.admit(input);
    if (decision.kind !== 'reserved') throw new Error(`expected reserved, got ${decision.kind}`);
    return { input, decision };
  }

  async function finish(carrierCallId: string) {
    await orchestration.applyCarrierCallback({
      organizationId,
      carrierId: 'twilio',
      provider: 'twilio',
      eventId: `${carrierCallId}:status:completed`,
      carrierCallId,
      status: 'completed',
      occurredAt: new Date(),
    });
    await operations.inbound.releaseByCarrierCallId(carrierCallId);
  }

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
    await pool.query('DELETE FROM ovo_worker_slots WHERE worker_id = $1', [workerId]);
    for (const table of [
      'ovo_ops_call_bindings',
      'ovo_ops_inbound_admissions',
      'ovo_ops_inbound_capacity',
      'ovo_ops_inbound_routes',
    ])
      await pool.query(`DELETE FROM ${table} WHERE organization_id = $1`, [organizationId]);
    await pool.end();
  });

  it('reserves the slot at admission, so outbound admission no longer counts it idle', async () => {
    await report('ready_idle');
    const before = await orchestration.admissionSnapshot();
    const { input } = await admit();
    expect(await slotState()).toBe('reserved');
    const after = await orchestration.admissionSnapshot();
    expect(after.readyIdleSlots).toBe(before.readyIdleSlots - 1);
    expect(after.busySlots).toBe(before.busySlots + 1);
    // The worker's next tick still says idle; the live route keeps the reservation.
    await report('ready_idle');
    expect(await slotState()).toBe('reserved');
    await finish(input.carrierCallId);
    await report('ready_idle');
    expect(await slotState()).toBe('ready_idle');
  });

  it('resumes a dropped stream before the worker has reported the session', async () => {
    const { input, decision } = await admit('resume-token');
    const opened = await orchestration.authenticateSessionRoute(decision.sessionId, 'resume-token');
    expect(opened?.sessionId).toBe(decision.sessionId);
    await orchestration.applyCarrierCallback({
      organizationId,
      carrierId: 'twilio',
      provider: 'twilio',
      eventId: `${input.carrierCallId}:status:answered`,
      carrierCallId: input.carrierCallId,
      status: 'answered',
      occurredAt: new Date(),
    });
    await report('ready_idle');
    const resumed = await orchestration.reissueStream({
      organizationId,
      carrierId: 'twilio',
      carrierCallId: input.carrierCallId,
      tokenHash: hash('second-token'),
      expiresAt: new Date(Date.now() + 60_000),
      workerFreshSeconds: 15,
    });
    expect(resumed).toMatchObject({ sessionId: decision.sessionId, generation: epoch + 1 });
    await finish(input.carrierCallId);
  });

  it('answers a duplicate webhook with the same reservation and one route', async () => {
    const { input, decision } = await admit();
    expect(await operations.inboundGateway.admit(input)).toEqual(decision);
    const routes = await pool.query(
      'SELECT 1 FROM ovo_session_routes WHERE organization_id = $1 AND carrier_call_id = $2',
      [organizationId, input.carrierCallId],
    );
    expect(routes.rowCount).toBe(1);
    expect(await slotState()).toBe('reserved');
    await finish(input.carrierCallId);
  });

  it('frees the slot when the stream never arrives and its handshake expires', async () => {
    const { decision } = await admit();
    await pool.query(
      `UPDATE ovo_session_routes SET handshake_expires_at = now() - interval '1 second'
       WHERE session_id = $1`,
      [decision.sessionId],
    );
    await report('ready_idle');
    expect(await slotState()).toBe('ready_idle');
  });
});
