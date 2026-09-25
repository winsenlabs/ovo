import { createServer } from 'node:http';
import {
  compose,
  definePlugin,
  type Context,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import {
  ecsCapacityWriterPlugin,
  postgresOrchestrationPlugin,
  sqsOrchestrationPlugin,
  type CapacityInput,
  type EcsDesiredCountWriter,
  type DesiredCountWriter,
  type PostgresOrchestrationStore,
} from '@winsendotai/ovo-plugin-orchestration';
import { dispatcherPlugin, type DispatcherService } from './index.ts';
import { PostgresControlStore, type ControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  OperationsOutboxDispatcher,
  PostgresOperationsService,
} from '@winsendotai/ovo-plugin-operations';

type ReadableDesiredWriter = DesiredCountWriter & {
  read(
    serviceKey: string,
  ): Promise<{ desiredCount: number; runningCount: number; pendingCount: number }>;
};

const compactCapacityWriterPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-dispatcher/compact-static-capacity',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['capacity.writer'],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx: Context) => {
    const writer: ReadableDesiredWriter = {
      authorityId: 'compact-static-two-workers',
      async write(_serviceKey, desiredCount) {
        if (desiredCount !== 2)
          throw new Error('Compact profile capacity is statically bounded to two workers');
      },
      async read() {
        return { desiredCount: 2, runningCount: 2, pendingCount: 0 };
      },
    };
    ctx.provide('capacity.writer', writer);
  },
);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

let healthy = false;
let detail = 'initializing';
let lastCapacity: unknown;
const server = createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ healthy, detail, lastCapacity }));
});
server.listen(Number(process.env.PORT ?? 4002), '0.0.0.0');

async function main(): Promise<void> {
  const authorityId = env('OVO_CAPACITY_AUTHORITY');
  const compact = process.env.OVO_DESIRED_WRITER === 'compose-static-two-workers';
  const capacityPlugin: PluginDefinition = compact
    ? compactCapacityWriterPlugin
    : ecsCapacityWriterPlugin;
  const capacityConfig = compact
    ? {}
    : {
        authorityId,
        cluster: env('OVO_ECS_CLUSTER'),
        workerService: env('OVO_WORKER_SERVICE'),
        region: env('AWS_REGION'),
      };
  const rows = [
    {
      id: postgresOrchestrationPlugin.manifest.id,
      config: { connectionString: env('DATABASE_URL') },
    },
    {
      id: sqsOrchestrationPlugin.manifest.id,
      config: {
        queueUrl: env('OVO_QUEUE_URL'),
        region: env('AWS_REGION'),
        endpoint: process.env.OVO_SQS_ENDPOINT || undefined,
      },
    },
    { id: capacityPlugin.manifest.id, config: capacityConfig },
    {
      id: dispatcherPlugin.manifest.id,
      config: { dispatcherId: env('OVO_DISPATCHER_ID'), serviceKey: 'workers' },
    },
  ];
  const composition = await compose(rows, [
    postgresOrchestrationPlugin,
    sqsOrchestrationPlugin,
    capacityPlugin,
    dispatcherPlugin,
  ]);
  const store = composition.ctx.get('orchestration.store') as PostgresOrchestrationStore;
  const writer = composition.ctx.get('capacity.writer') as
    EcsDesiredCountWriter | ReadableDesiredWriter;
  const dispatcher = composition.ctx.get('dispatcher.service') as DispatcherService;
  const operations = new PostgresOperationsService({
    organizationId: env('OVO_ORGANIZATION_ID'),
    connectionString: env('DATABASE_URL'),
    handoffProvider: {
      async request() {
        return { kind: 'unknown' as const, reason: 'dispatcher cannot transfer calls' };
      },
      async reconcile() {
        return { kind: 'pending' as const };
      },
      async fallback() {
        return { kind: 'unknown' as const, reason: 'dispatcher cannot transfer calls' };
      },
    },
  });
  await operations.migrate();
  const campaignOutbox = new OperationsOutboxDispatcher(
    env('OVO_DISPATCHER_ID'),
    operations.outbox,
    {
      async enqueue(input) {
        await store.enqueue({
          id: input.jobId,
          workspaceId: env('OVO_ORGANIZATION_ID'),
          idempotencyKey: input.idempotencyKey,
          payload: input.payload,
          notBefore: input.notBefore,
        });
      },
    },
  );
  const controlStore = await PostgresControlStore.open(
    process.env.OVO_CONTROL_DATABASE_URL ?? env('DATABASE_URL'),
  );
  await store.ping();
  healthy = true;
  detail = compact
    ? 'Required Postgres, SQS and static compact capacity adapters composed'
    : 'Required Postgres, SQS and sole ECS writer adapters composed';

  const flush = setInterval(
    () =>
      void Promise.all([
        dispatcher.flushOutbox(),
        campaignOutbox.flush(),
        releaseTerminalCalls(store, controlStore),
      ]).catch((error) => {
        healthy = false;
        detail = `durability:${String(error)}`;
      }),
    1_000,
  );
  const scale = setInterval(
    () =>
      void (async () => {
        const [snapshot, ecs] = await Promise.all([
          store.readCapacitySnapshot(),
          writer.read('workers'),
        ]);
        const unregisteredStarting = Math.max(
          0,
          ecs.runningCount + ecs.pendingCount - snapshot.counts.total,
        );
        const counts = {
          ...snapshot.counts,
          starting: snapshot.counts.starting + unregisteredStarting,
        };
        counts.total =
          counts.readyIdle + counts.reserved + counts.active + counts.starting + counts.draining;
        const input: CapacityInput = {
          nowMs: Date.now(),
          observedAtMs: snapshot.observedAtMs,
          maxMetricAgeMs: integer('OVO_CAPACITY_MAX_AGE_MS', 15_000),
          counts,
          currentDesired: ecs.desiredCount,
          eligibleUnclaimed: snapshot.eligibleUnclaimed,
          permittedNewStartsInHorizon: integer('OVO_PERMITTED_STARTS', 10),
          inbound: {
            enabled: integer('OVO_INBOUND_WARM_FLOOR', 0) > 0,
            warmIdleFloor: integer('OVO_INBOUND_WARM_FLOOR', 0),
            overflow: (process.env.OVO_INBOUND_OVERFLOW ?? 'callback') as
              'busy' | 'wait' | 'callback' | 'human',
          },
          limits: {
            configuredMin: 0,
            configuredMax: integer('OVO_WORKER_MAX_CAPACITY', 100),
            carrierConcurrency: integer('OVO_CARRIER_CONCURRENCY', 100),
            providerConcurrency: integer('OVO_PROVIDER_CONCURRENCY', 100),
            awsTaskLimit: integer('OVO_AWS_TASK_LIMIT', 100),
            spendPermittedStarts: integer('OVO_SPEND_PERMITTED_STARTS', 100),
          },
          maxScaleOutStep: integer('OVO_MAX_SCALE_OUT_STEP', 10),
          maxScaleInStep: integer('OVO_MAX_SCALE_IN_STEP', 1),
        };
        lastCapacity = await dispatcher.decideAndApplyCapacity(input);
        healthy = true;
        detail = 'dispatcher loops healthy';
      })().catch((error) => {
        healthy = false;
        detail = `capacity:${String(error)}`;
      }),
    5_000,
  );
  flush.unref();
  scale.unref();

  const shutdown = async () => {
    healthy = false;
    detail = 'draining';
    clearInterval(flush);
    clearInterval(scale);
    await operations.close();
    await controlStore.close();
    await composition.dispose();
    server.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

async function releaseTerminalCalls(
  store: PostgresOrchestrationStore,
  controlStore: ControlStore,
): Promise<void> {
  for (const route of await store.listTerminalSessions()) {
    const job = await store.get(route.jobId);
    if (job) {
      const callId =
        typeof job.payload.callId === 'string' && job.payload.callId ? job.payload.callId : job.id;
      if (await controlStore.getCall(job.workspaceId, callId))
        await controlStore.finishCall(job.workspaceId, callId, route.status);
    }
    await store.releaseTerminalSession(route.jobId);
  }
}

main().catch((error: unknown) => {
  healthy = false;
  detail = error instanceof Error ? error.message : String(error);
  console.error('dispatcher startup failed:', detail);
  process.exitCode = 1;
});
