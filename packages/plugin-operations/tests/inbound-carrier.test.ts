import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { PostgresOrchestrationStore } from '../../plugin-orchestration/src/index.ts';
import { PostgresOperationsService } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('inbound carrier selection durability', () => {
  const organizationId = `inbound-carrier-${randomUUID()}`;
  const releaseId = randomUUID();
  const envNumber = '+14155550198';
  const missingPluginNumber = '+14155550200';
  const emptyPluginNumber = '+14155550204';
  const waitSnapshotNumber = '+14155550202';
  const pool = new Pool({ connectionString: postgresUrl, max: 4 });
  const orchestration = new PostgresOrchestrationStore(pool);
  const operations = new PostgresOperationsService({
    pool,
    organizationId,
    config: {
      liveEnabled: true,
      permittedFromNumbers: [envNumber, missingPluginNumber, emptyPluginNumber, waitSnapshotNumber],
    },
  });

  beforeAll(async () => {
    await orchestration.migrate();
    await operations.migrate();
    await operations.inbound.setPolicy({ kind: 'busy', reason: 'at capacity' }, null);
    operations.inboundGateway.setInstalledCarrierPlugins(['@winsendotai/ovo-carrier-twilio']);
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

  it('preserves NULL as the environment binding in both durable rows', async () => {
    await operations.inboundRoutes.put({
      phoneNumber: envNumber,
      releaseId,
      expectedVersion: null,
      carrierPluginId: null,
      carrierBindingId: null,
    });
    await operations.inbound.registerProtectedCapacity({
      slotId: `env-slot-${randomUUID()}`,
      workerId: 'worker-env',
      workerEndpoint: 'wss://worker.internal.example/env-session',
      generation: 19,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
    const admitted = await operations.inboundGateway.admit({
      carrierCallId: `CA${'9'.repeat(32)}`,
      fromNumber: '+14155550199',
      toNumber: envNumber,
      routeTokenHash: '9'.repeat(64),
      handshakeTtlMs: 60_000,
    });
    expect(admitted.kind).toBe('reserved');
    if (admitted.kind !== 'reserved') return;
    const job = await pool.query(
      'SELECT carrier_plugin_id, carrier_binding_id, binding_id FROM ovo_jobs WHERE id = $1',
      [admitted.jobId],
    );
    const session = await pool.query(
      'SELECT carrier_plugin_id, carrier_binding_id, binding_id FROM ovo_session_routes WHERE session_id = $1',
      [admitted.sessionId],
    );
    expect(job.rows[0]).toEqual({
      carrier_plugin_id: null,
      carrier_binding_id: null,
      binding_id: null,
    });
    expect(session.rows[0]).toEqual({
      carrier_plugin_id: null,
      carrier_binding_id: null,
      binding_id: null,
    });
    const payload = await pool.query('SELECT payload FROM ovo_jobs WHERE id = $1', [
      admitted.jobId,
    ]);
    expect(payload.rows[0].payload).toMatchObject({
      carrierPluginId: null,
      carrierBindingId: null,
    });
  });

  it('fails closed before reservation when the route plugin is not installed', async () => {
    await operations.inboundRoutes.put({
      phoneNumber: missingPluginNumber,
      releaseId,
      expectedVersion: null,
      carrierPluginId: '@example/not-installed',
      carrierBindingId: 'some-binding',
    });
    await operations.inbound.registerProtectedCapacity({
      slotId: `unknown-slot-${randomUUID()}`,
      workerId: 'worker-unknown',
      workerEndpoint: 'wss://worker.internal.example/unknown-session',
      generation: 20,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
    const carrierCallId = `CA${'8'.repeat(32)}`;
    await expect(
      operations.inboundGateway.admit({
        carrierCallId,
        fromNumber: '+14155550201',
        toNumber: missingPluginNumber,
        routeTokenHash: '8'.repeat(64),
        handshakeTtlMs: 60_000,
      }),
    ).rejects.toThrow('Inbound carrier plugin is not installed: @example/not-installed');
    expect(
      (
        await pool.query(
          'SELECT 1 FROM ovo_ops_inbound_admissions WHERE organization_id = $1 AND call_id = $2',
          [organizationId, carrierCallId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('does not treat an empty explicit plugin ID as the NULL environment binding', async () => {
    await operations.inboundRoutes.put({
      phoneNumber: emptyPluginNumber,
      releaseId,
      expectedVersion: null,
      carrierPluginId: '',
      carrierBindingId: null,
    });
    const carrierCallId = `CA${randomUUID().replaceAll('-', '')}`;
    await expect(
      operations.inboundGateway.admit({
        carrierCallId,
        fromNumber: '+14155550205',
        toNumber: emptyPluginNumber,
        routeTokenHash: '6'.repeat(64),
        handshakeTtlMs: 60_000,
      }),
    ).rejects.toThrow('Inbound carrier plugin is not installed: ');
    expect(
      (
        await pool.query(
          'SELECT 1 FROM ovo_ops_inbound_admissions WHERE organization_id = $1 AND call_id = $2',
          [organizationId, carrierCallId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('retains a waiting admission carrier snapshot across a route edit', async () => {
    await pool.query(
      'UPDATE ovo_ops_inbound_capacity SET ready = false WHERE organization_id = $1',
      [organizationId],
    );
    await operations.inboundRoutes.put({
      phoneNumber: waitSnapshotNumber,
      releaseId,
      expectedVersion: null,
      carrierPluginId: '@winsendotai/ovo-carrier-twilio',
      carrierBindingId: 'wait-binding',
    });
    await pool.query(
      'UPDATE ovo_ops_inbound_policy SET policy = $2::jsonb WHERE organization_id = $1',
      [organizationId, JSON.stringify({ kind: 'wait', maxWaitMs: 30_000, announcement: 'Hold' })],
    );
    const input = {
      carrierCallId: `CA${randomUUID().replaceAll('-', '')}`,
      fromNumber: '+14155550203',
      toNumber: waitSnapshotNumber,
      routeTokenHash: '7'.repeat(64),
      handshakeTtlMs: 60_000,
    };
    expect((await operations.inboundGateway.admit(input)).kind).toBe('wait');
    await operations.inboundRoutes.put({
      phoneNumber: waitSnapshotNumber,
      releaseId,
      expectedVersion: 1,
      carrierPluginId: '@example/not-installed',
      carrierBindingId: 'changed',
    });
    await operations.inbound.registerProtectedCapacity({
      slotId: `wait-carrier-slot-${randomUUID()}`,
      workerId: 'worker-wait-carrier',
      workerEndpoint: 'wss://worker.internal.example/wait-carrier',
      generation: 21,
      ready: true,
      protectedUntil: new Date(Date.now() + 180_000),
    });
    const admitted = await operations.inboundGateway.admit(input);
    expect(admitted.kind).toBe('reserved');
    if (admitted.kind !== 'reserved') return;
    const job = await pool.query(
      'SELECT carrier_plugin_id, carrier_binding_id FROM ovo_jobs WHERE id = $1',
      [admitted.jobId],
    );
    const session = await pool.query(
      'SELECT carrier_plugin_id, carrier_binding_id FROM ovo_session_routes WHERE session_id = $1',
      [admitted.sessionId],
    );
    expect(job.rows[0]).toEqual({
      carrier_plugin_id: '@winsendotai/ovo-carrier-twilio',
      carrier_binding_id: 'wait-binding',
    });
    expect(session.rows[0]).toEqual(job.rows[0]);
    await pool.query(
      'UPDATE ovo_ops_inbound_policy SET policy = $2::jsonb WHERE organization_id = $1',
      [organizationId, JSON.stringify({ kind: 'busy', reason: 'at capacity' })],
    );
  });
});
