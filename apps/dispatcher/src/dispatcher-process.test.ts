import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import { randomUUID } from 'node:crypto';
import { Cap, type BackgroundTask } from '@winsendotai/ovo-contracts';
import { dispatcherIdentity, openDispatcherProcess } from './dispatcher-process.ts';
import { startDispatcher } from './main.ts';

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
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'local-dispatcher-test');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local-dispatcher-test');
    vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true');
    admin = new PostgresOrchestrationStore({
      connectionString: process.env.OVO_TEST_POSTGRES_URL!,
    });
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.OVO_TEST_POSTGRES_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = url.toString();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
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
        OVO_SQS_ENDPOINT: 'http://127.0.0.1:1',
        OVO_DEPLOYMENT_PROFILE: 'fargate',
        OVO_CAPACITY_SIGNAL: 'cloudwatch',
        OVO_ENVIRONMENT: 'test',
        OVO_INBOUND_ENABLED: 'false',
        AWS_REGION: 'us-east-1',
        AWS_EC2_METADATA_DISABLED: 'true',
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

  it('serves 503 while the first capacity input is pending', async () => {
    let releaseRead = () => {};
    let markReading = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReading = resolve;
    });
    const runtime = await startDispatcher({
      env: {
        DATABASE_URL: databaseUrl,
        OVO_ORGANIZATION_ID: 'dispatcher-health-test',
        OVO_QUEUE_URL: 'http://127.0.0.1:1/unused-jobs',
        OVO_DLQ_URL: 'http://127.0.0.1:1/unused-dlq',
        OVO_SQS_ENDPOINT: 'http://127.0.0.1:1',
        OVO_DEPLOYMENT_PROFILE: 'compose',
        OVO_CAPACITY_SIGNAL: 'log',
        OVO_INBOUND_ENABLED: 'false',
        AWS_REGION: 'us-east-1',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
      readProvisionedTasks: async () => {
        markReading();
        await readGate;
        return 2;
      },
      host: '127.0.0.1',
      port: 0,
    });
    try {
      await readStarted;
      const address = runtime.server.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
      expect((await fetch(`http://127.0.0.1:${address.port}/health`)).status).toBe(503);
    } finally {
      releaseRead();
      await runtime.close();
    }
  });

  it('publishes a durable signal and runs the installed hint sweeper', async () => {
    const runtime = await openDispatcherProcess({
      env: {
        DATABASE_URL: databaseUrl,
        OVO_ORGANIZATION_ID: 'dispatcher-profile-test',
        OVO_QUEUE_URL: 'http://127.0.0.1:1/unused-jobs',
        OVO_DLQ_URL: 'http://127.0.0.1:1/unused-dlq',
        OVO_SQS_ENDPOINT: 'http://127.0.0.1:1',
        OVO_DEPLOYMENT_PROFILE: 'compose',
        OVO_CAPACITY_SIGNAL: 'log',
        OVO_INBOUND_ENABLED: 'false',
        OVO_INBOUND_WARM_FLOOR: '2',
        AWS_REGION: 'us-east-1',
        AWS_EC2_METADATA_DISABLED: 'true',
      },
      readProvisionedTasks: async () => 2,
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
      expect(runtime.loop.health()).toMatchObject({ healthy: false, detail: 'initializing' });
      await store.pool.query(
        `INSERT INTO ovo_jobs (id, workspace_id, idempotency_key, payload, status,
           not_before, hinted_at, hint_count)
         VALUES ($1, 'dispatcher-profile-test', $2, '{}'::jsonb, 'queued',
           now(), NULL, 0)`,
        [id, id],
      );
      const sweeper = runtime.composition
        .all(Cap.backgroundTask)
        .get('@winsendotai/ovo-plugin-orchestration/job-hint-sweeper') as
        BackgroundTask | undefined;
      expect(sweeper).toBeDefined();
      await sweeper!.tick(new AbortController().signal);
      await runtime.loop.capacityTick();
      expect(runtime.loop.health()).toMatchObject({
        healthy: true,
        lastCapacity: { provisionedTasks: 2 },
        // Inbound is off, so its readiness is reported while protected capacity stays 0.
        inbound: { admissionEnabled: false, readyProtected: 0, warmFloor: 2 },
      });
      const saved = await store.pool.query(
        `SELECT signal FROM ovo_capacity_signal_latest WHERE service_key='workers'`,
      );
      expect(saved.rows[0]?.signal).toBeDefined();
      const swept = (
        await store.pool.query(
          `SELECT j.hint_count, count(o.id)::int AS outbox_count FROM ovo_jobs j
         LEFT JOIN ovo_outbox o ON o.aggregate_id=j.id AND o.topic='job.eligible'
         WHERE j.id=$1 GROUP BY j.id`,
          [id],
        )
      ).rows[0];
      expect(swept).toMatchObject({ hint_count: 1, outbox_count: 1 });
    } finally {
      await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id=$1', [id]);
      await store.pool.query('DELETE FROM ovo_jobs WHERE id=$1', [id]);
      await runtime.close();
    }
  }, 15_000);
});
