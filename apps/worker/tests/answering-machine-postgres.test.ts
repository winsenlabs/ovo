import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { watchAnsweredBy } from '../src/answering-machine.ts';

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)(
  'answering-machine verdict on a durable route',
  () => {
    const schema = `w2_amd_${randomUUID().replaceAll('-', '')}`;
    let admin: PostgresOrchestrationStore;
    let store: PostgresOrchestrationStore;

    beforeAll(async () => {
      admin = new PostgresOrchestrationStore({
        connectionString: process.env.OVO_TEST_POSTGRES_URL,
      });
      await admin.pool.query(`CREATE SCHEMA ${schema}`);
      store = new PostgresOrchestrationStore({
        connectionString: process.env.OVO_TEST_POSTGRES_URL,
        options: `-c search_path=${schema}`,
      });
      await store.migrate();
    });

    afterAll(async () => {
      await store?.close();
      if (admin) {
        await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.close();
      }
    });

    it('reads the verdict the gateway recorded from the carrier callback', async () => {
      const jobId = randomUUID();
      const sessionId = randomUUID();
      await store.enqueue({ id: jobId, workspaceId: schema, idempotencyKey: jobId, payload: {} });
      const claimed = await store.claim(jobId, 'worker-1', 60_000);
      if (claimed.kind !== 'execute') throw new Error('expected claim');
      await store.beginDialSession({
        sessionId,
        jobId,
        organizationId: schema,
        workerId: 'worker-1',
        workerEndpoint: 'ws://worker.test:4100/internal/media',
        ownerEpoch: claimed.job.ownerEpoch,
        generation: 1,
        dialRequestId: `${jobId}:${claimed.job.ownerEpoch}`,
        carrierId: 'twilio',
        handshakeTokenHash: 'test-hash',
        handshakeExpiresAt: new Date(Date.now() + 60_000),
      });
      const deliver = vi.fn();
      const stop = watchAnsweredBy({
        pool: store.pool,
        route: { sessionId, organizationId: schema },
        deliver,
        intervalMs: 10,
      });
      // The same write gateway-host makes for Twilio's AsyncAmdStatusCallback.
      const applied = await store.applyCarrierCallback({
        organizationId: schema,
        carrierId: 'twilio',
        provider: 'twilio',
        eventId: 'CA-1:amd:machine_end_beep',
        carrierCallId: 'CA-1',
        dialRequestId: `${jobId}:${claimed.job.ownerEpoch}`,
        status: 'answered',
        occurredAt: new Date(),
        payload: { answeredBy: 'machine' },
      });
      expect(applied.kind).not.toBe('unmatched');
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith('machine'));
      stop();
    });
  },
);
