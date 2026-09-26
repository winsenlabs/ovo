import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { randomUUID } from 'node:crypto';
import { Cap } from '@winsendotai/ovo-contracts';
import { dispatcherIdentity, openDispatcherProcess } from './dispatcher-process.ts';
import { startDispatcher } from './main.ts';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Dispatcher production task did not complete within 8 seconds');
}

describe('dispatcher process entry', () => {
  it('uses ECS TaskARN as the replica identity when metadata supplies one', async () => {
    const id = await dispatcherIdentity(
      { ECS_CONTAINER_METADATA_URI_V4: 'http://metadata.test' },
      async () =>
        ({ ok: true, json: async () => ({ TaskARN: 'arn:aws:ecs:task/unique' }) }) as Response,
    );
    expect(id).toBe('arn:aws:ecs:task/unique');
  });
});

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)('dispatcher production profile', () => {
  const schema = `dispatcher_process_${randomUUID().replaceAll('-', '')}`;
  let admin: PostgresOrchestrationStore;
  let databaseUrl: string;
  beforeAll(async () => {
    admin = new PostgresOrchestrationStore({
      connectionString: process.env.OVO_TEST_POSTGRES_URL!,
    });
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.OVO_TEST_POSTGRES_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
  });
  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  });
  it('composes only the CloudWatch signal row on Fargate without making an AWS call', async () => {
    const runtime = await openDispatcherProcess({
      env: {
        DATABASE_URL: databaseUrl,
        OVO_ORGANIZATION_ID: 'dispatcher-fargate-profile-test',
        OVO_QUEUE_URL: 'http://127.0.0.1:1/unused-jobs',
        OVO_DLQ_URL: 'http://127.0.0.1:1/unused-dlq',
        OVO_DEPLOYMENT_PROFILE: 'fargate',
        OVO_CAPACITY_SIGNAL: 'cloudwatch',
        OVO_ENVIRONMENT: 'test',
        OVO_INBOUND_ENABLED: 'false',
        AWS_REGION: 'us-east-1',
      },
      readProvisionedTasks: async () => 2,
    });
    try {
      expect(runtime.composition.lock.map((item) => item.id)).toContain(
        '@winsendotai/ovo-plugin-orchestration/cloudwatch-capacity-signal',
      );
      expect(runtime.composition.lock.map((item) => item.id)).not.toContain(
        '@winsendotai/ovo-plugin-orchestration/log-capacity-signal',
      );
      expect(runtime.composition.get(Cap.capacitySignal)).toBeDefined();
    } finally {
      await runtime.close();
    }
  });

  it('starts unhealthy, then publishes a durable signal and runs the installed hint sweeper', async () => {
    let releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reading = false;
    const runtime = await startDispatcher({
      env: {
        DATABASE_URL: databaseUrl,
        OVO_ORGANIZATION_ID: 'dispatcher-profile-test',
        OVO_QUEUE_URL: 'http://127.0.0.1:1/unused-jobs',
        OVO_DLQ_URL: 'http://127.0.0.1:1/unused-dlq',
        OVO_DEPLOYMENT_PROFILE: 'compose',
        OVO_CAPACITY_SIGNAL: 'log',
        OVO_INBOUND_ENABLED: 'false',
        OVO_INBOUND_WARM_FLOOR: '2',
        AWS_REGION: 'us-east-1',
      },
      readProvisionedTasks: async () => {
        reading = true;
        await readGate;
        return 2;
      },
      host: '127.0.0.1',
      port: 0,
    });
    const id = randomUUID();
    const store = runtime.composition.get(Cap.orchestrationStore) as {
      pool: { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
    };
    try {
      for (const key of [
        Cap.orchestrationStore,
        Cap.orchestrationQueue,
        Cap.operations,
        Cap.costLedger,
        Cap.net,
        Cap.capacitySignal,
      ]) {
        expect(runtime.composition.get(key), `missing ${key}`).toBeDefined();
      }
      expect(runtime.composition.all(Cap.backgroundTask).size).toBeGreaterThanOrEqual(2);
      const address = runtime.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      const healthUrl = `http://127.0.0.1:${address.port}/health`;
      await until(async () => reading, Boolean);
      expect((await fetch(healthUrl)).status).toBe(503);
      await store.pool.query(
        `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
           not_before, hinted_at, hint_count)
         VALUES ($1, 'dispatcher-profile-test', $2, '{}'::jsonb, 'queued',
           now(), NULL, 0)`,
        [id, id],
      );
      releaseRead();
      const response = await until(
        () => fetch(healthUrl),
        (value) => value.status === 200,
      );
      expect(await response.json()).toMatchObject({
        healthy: true,
        lastCapacity: { provisionedTasks: 2 },
      });
      const saved = await store.pool.query(
        `SELECT signal FROM ovo_capacity_signal_latest WHERE service_key='workers'`,
      );
      expect(saved.rows[0]?.signal).toBeDefined();
      const swept = await until(
        async () =>
          (
            await store.pool.query(
              `SELECT j.hint_count, count(o.id)::int AS outbox_count FROM ovo_jobs j
         LEFT JOIN ovo_outbox o ON o.aggregate_id=j.id AND o.topic='job.eligible'
         WHERE j.id=$1 GROUP BY j.id`,
              [id],
            )
          ).rows[0],
        (value) => Number(value?.hint_count) >= 1 && Number(value?.outbox_count) >= 1,
      );
      expect(swept).toMatchObject({ hint_count: 1, outbox_count: 1 });
    } finally {
      releaseRead();
      await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id=$1', [id]);
      await store.pool.query('DELETE FROM ovo_jobs WHERE id=$1', [id]);
      await runtime.close();
    }
  }, 15_000);
});
