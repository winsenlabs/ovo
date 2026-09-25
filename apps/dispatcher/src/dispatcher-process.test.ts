import { describe, expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { dispatcherIdentity } from './dispatcher-process.ts';
import { startDispatcher } from './main.ts';

describe('dispatcher process entry', () => {
  it('uses ECS TaskARN as the replica identity when metadata supplies one', async () => {
    const id = await dispatcherIdentity({ ECS_CONTAINER_METADATA_URI_V4: 'http://metadata.test' },
      async () => ({ ok: true, json: async () => ({ TaskARN: 'arn:aws:ecs:task/unique' }) }) as Response);
    expect(id).toBe('arn:aws:ecs:task/unique');
  });
});

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)('dispatcher production profile', () => {
  it('composes host services and publishes a durable capacity signal through the real loop', async () => {
    const runtime = await startDispatcher({
      env: {
        DATABASE_URL: process.env.OVO_TEST_POSTGRES_URL,
        OVO_ORGANIZATION_ID: 'dispatcher-profile-test',
        OVO_QUEUE_URL: 'http://127.0.0.1:1/unused-jobs',
        OVO_DLQ_URL: 'http://127.0.0.1:1/unused-dlq',
        OVO_DEPLOYMENT_PROFILE: 'compose',
        OVO_CAPACITY_SIGNAL: 'log',
        OVO_INBOUND_ENABLED: 'false',
        OVO_INBOUND_WARM_FLOOR: '2',
        AWS_REGION: 'us-east-1',
      },
      readProvisionedTasks: async () => 2,
      host: '127.0.0.1', port: 0,
    });
    try {
      for (const key of [Cap.orchestrationStore, Cap.orchestrationQueue,
        Cap.operations, Cap.costLedger, Cap.net, Cap.capacitySignal]) {
        expect(runtime.composition.get(key), `missing ${key}`).toBeDefined();
      }
      expect(runtime.composition.all(Cap.backgroundTask).size).toBeGreaterThanOrEqual(2);
      await runtime.loop.capacityTick();
      expect(runtime.loop.health()).toMatchObject({ healthy: true,
        lastCapacity: { requiredSlots: 0, provisionedTasks: 2 } });
      const store = runtime.composition.get(Cap.orchestrationStore) as {
        pool: { query(sql: string): Promise<{ rows: { signal: { requiredSlots: number } }[] }> };
      };
      const saved = await store.pool.query(
        `SELECT signal FROM ovo_capacity_signal_latest WHERE service_key='workers'`,
      );
      expect(saved.rows[0]?.signal.requiredSlots).toBe(0);
      const address = runtime.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ healthy: true,
        lastCapacity: { requiredSlots: 0 } });
    } finally {
      await runtime.close();
    }
  });
});
