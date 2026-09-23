import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { twilioCarrierBridge } from '../../../packages/distribution/src/legacy/twilio-carrier.ts';
import { PostgresOperationsService } from '../../../packages/plugin-operations/src/index.ts';
import { PostgresOrchestrationStore } from '../../../packages/plugin-orchestration/src/index.ts';
import { ApiCarrierHandoffPort } from '../src/carrier-handoff.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('carrier handoff durable request fence', () => {
  const pool = new Pool({ connectionString: postgresUrl, max: 2 });
  const organizationId = `handoff-${randomUUID()}`;
  const jobId = randomUUID();
  const sessionId = randomUUID();
  const carrierCallId = `CA${randomUUID().replaceAll('-', '')}`;
  const requestId = `handoff:${randomUUID()}`;
  const handoff = vi.fn(async () => ({ kind: 'confirmed' as const, receiptId: 'receipt-1' }));

  beforeAll(async () => {
    await new PostgresOrchestrationStore(pool).migrate();
    await new PostgresOperationsService({ pool, organizationId }).migrate();
    await pool.query(
      `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status)
       VALUES ($1,$2,$3,$4::jsonb,'accepted')`,
      [jobId, organizationId, jobId, JSON.stringify({ releaseId: 'release-1' })],
    );
    await pool.query(
      `INSERT INTO ovo_session_routes
       (session_id, job_id, organization_id, worker_id, worker_endpoint,
        owner_epoch, generation, dial_request_id, carrier_id, carrier_call_id,
        status, handshake_token_hash, handshake_expires_at)
       VALUES ($1,$2,$3,'worker-1','wss://worker.test/session',1,1,$4,'twilio',$5,
        'accepted','test-hash',now() + interval '1 minute')`,
      [sessionId, jobId, organizationId, `dial:${jobId}`, carrierCallId],
    );
    await pool.query(
      `INSERT INTO ovo_ops_handoffs
       (id, organization_id, operation_id, input_digest, session_id, carrier_call_id,
        target, fallback, status, request_id)
       VALUES ($1,$2,$3,'digest',$4,$5,'{}'::jsonb,'{}'::jsonb,'submitting',$6)`,
      [randomUUID(), organizationId, `operation:${jobId}`, sessionId, carrierCallId, requestId],
    );
  });
  afterAll(async () => {
    await pool.query('DELETE FROM ovo_ops_handoffs WHERE organization_id = $1', [organizationId]);
    await pool.query('DELETE FROM ovo_session_routes WHERE session_id = $1', [sessionId]);
    await pool.query('DELETE FROM ovo_jobs WHERE id = $1', [jobId]);
    await pool.end();
  });

  it('refuses another request ID for the same carrier call and accepts the owned request', async () => {
    const port = new ApiCarrierHandoffPort({
      organizationId,
      catalog: [twilioCarrierBridge],
      ctx: {
        all: () =>
          new Map([
            [
              'twilio',
              {
                capabilities: { carrierId: 'twilio' },
                create: () => ({ handoff }),
              },
            ],
          ]),
      } as never,
      store: {
        getRelease: async () => ({ agentId: 'agent-1' }),
        getProviderBinding: async () => undefined,
      } as never,
      secrets: { forAgent: () => ({ resolve: async () => 'unused' }) } as never,
      environment: {
        OVO_CARRIER_ENV_BINDINGS: JSON.stringify({
          twilio: { authToken: 'test-secret' },
        }),
      },
    });
    port.attach(pool);
    await expect(
      port.request({
        requestId: 'other-request',
        carrierCallId,
        target: { kind: 'phone', value: '+14155550100' },
      }),
    ).rejects.toThrow('route is missing or ambiguous');
    expect(handoff).not.toHaveBeenCalled();
    await expect(
      port.request({
        requestId,
        carrierCallId,
        target: { kind: 'phone', value: '+14155550100' },
      }),
    ).resolves.toEqual({ kind: 'confirmed', receiptId: 'receipt-1' });
    expect(handoff).toHaveBeenCalledWith(
      carrierCallId,
      { kind: 'phone', e164: '+14155550100' },
      requestId,
    );
  });
});
