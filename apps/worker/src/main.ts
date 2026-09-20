import { createServer } from 'node:http';
import {
  compose,
  definePlugin,
  type Context,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import {
  postgresOrchestrationPlugin,
  sqsOrchestrationPlugin,
  type DurableQueue,
  type PostgresOrchestrationStore,
  type QueueDelivery,
  type ReadinessProbe,
  type TaskProtection,
} from '@winsendotai/ovo-plugin-orchestration';
import { twilioTelephonyPlugin } from '@winsendotai/ovo-plugin-telephony-twilio';
import { workerRunnerPlugin, type DeliveryOutcome, type WorkerRunner } from './index.ts';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optionalEndpoint(): string | undefined {
  return process.env.OVO_SQS_ENDPOINT || undefined;
}

const localProtectionPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-worker/local-process-protection',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['worker.protection'],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx: Context) => {
    let protectionActive = false;
    const service: TaskProtection = {
      async establish() {
        protectionActive = true;
        return true;
      },
      async renew() {
        return protectionActive;
      },
      async release() {
        protectionActive = false;
      },
    };
    ctx.provide('worker.protection', service);
  },
);

const readinessPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-worker/readiness',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: ['orchestration.store'],
    provides: ['worker.readiness'],
    configSchema: {
      type: 'object',
      required: ['mediaReadinessUrl'],
      properties: { mediaReadinessUrl: { type: 'string' } },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    const store = ctx.get('orchestration.store') as PostgresOrchestrationStore;
    const url = typeof config.mediaReadinessUrl === 'string' ? config.mediaReadinessUrl : '';
    const readiness: ReadinessProbe = {
      async check() {
        try {
          await store.ping();
          if (process.env.OVO_TRANSPORT_CERTIFIED !== 'true')
            return { ready: false as const, reason: 'transport-not-certified' };
          if (!url) return { ready: false as const, reason: 'media-session-handler-not-composed' };
          const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
          if (!response.ok)
            return { ready: false as const, reason: `media-readiness-${response.status}` };
          return { ready: true as const };
        } catch (error) {
          return {
            ready: false as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
    ctx.provide('worker.readiness', readiness);
  },
);

async function ecsProtectionConfig(): Promise<Record<string, unknown>> {
  const metadataUri = env('ECS_CONTAINER_METADATA_URI_V4');
  const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`ECS task metadata failed: ${response.status}`);
  const metadata = (await response.json()) as { Cluster?: unknown; TaskARN?: unknown };
  if (typeof metadata.Cluster !== 'string' || typeof metadata.TaskARN !== 'string')
    throw new Error('ECS task metadata lacks cluster/task ARN');
  process.env.OVO_WORKER_ID ??= metadata.TaskARN;
  return {
    cluster: metadata.Cluster,
    taskArn: metadata.TaskARN,
    region: env('AWS_REGION'),
    expiresInMinutes: 10,
  };
}

let state: 'starting' | 'dial-disabled' | 'ready' | 'active' | 'draining' | 'failed' = 'starting';
let detail = 'initializing';
const port = Number(process.env.PORT ?? 4100);
const server = createServer((request, response) => {
  if (request.url !== '/health' && request.url !== '/ready') {
    response.writeHead(404).end();
    return;
  }
  const healthy = state !== 'failed';
  const ready = state === 'ready' || state === 'dial-disabled';
  response.writeHead(request.url === '/ready' && !ready ? 503 : healthy ? 200 : 503, {
    'content-type': 'application/json',
  });
  response.end(
    JSON.stringify({
      state,
      detail,
      liveDialEnabled: process.env.OVO_LIVE_DIAL_ENABLED === 'true',
    }),
  );
});
server.listen(port, '0.0.0.0');

async function main(): Promise<void> {
  const liveDial = process.env.OVO_LIVE_DIAL_ENABLED === 'true';
  const baseRows = [
    {
      id: postgresOrchestrationPlugin.manifest.id,
      config: { connectionString: env('DATABASE_URL') },
    },
    {
      id: sqsOrchestrationPlugin.manifest.id,
      config: {
        queueUrl: env('OVO_QUEUE_URL'),
        region: env('AWS_REGION'),
        endpoint: optionalEndpoint(),
      },
    },
  ];
  const catalog: PluginDefinition[] = [postgresOrchestrationPlugin, sqsOrchestrationPlugin];
  if (!liveDial) {
    const composition = await compose(baseRows, catalog);
    state = 'dial-disabled';
    detail = 'Durable adapters composed; carrier admission is explicitly disabled';
    const shutdown = async () => {
      state = 'draining';
      await composition.dispose();
      server.close();
    };
    process.once('SIGTERM', () => void shutdown());
    process.once('SIGINT', () => void shutdown());
    return;
  }

  const protectionMode = process.env.OVO_PROTECTION_MODE ?? 'ecs';
  const protectionDefinition =
    protectionMode === 'process-lifecycle'
      ? localProtectionPlugin
      : (await import('@winsendotai/ovo-plugin-orchestration')).ecsProtectionPlugin;
  const protectionConfig =
    protectionMode === 'process-lifecycle' ? {} : await ecsProtectionConfig();
  const rows = [
    ...baseRows,
    { id: protectionDefinition.manifest.id, config: protectionConfig },
    {
      id: readinessPlugin.manifest.id,
      config: { mediaReadinessUrl: env('OVO_MEDIA_READINESS_URL') },
    },
    {
      id: twilioTelephonyPlugin.manifest.id,
      config: { accountSid: env('TWILIO_ACCOUNT_SID'), authToken: env('TWILIO_AUTH_TOKEN') },
    },
    {
      id: workerRunnerPlugin.manifest.id,
      config: { workerId: process.env.OVO_WORKER_ID ?? `compact-${process.pid}` },
    },
  ];
  const composition = await compose(rows, [
    ...catalog,
    protectionDefinition,
    readinessPlugin,
    twilioTelephonyPlugin,
    workerRunnerPlugin,
  ]);
  const store = composition.ctx.get('orchestration.store') as PostgresOrchestrationStore;
  const queue = composition.ctx.get('orchestration.queue') as DurableQueue;
  const runner = composition.ctx.get('worker.runner') as WorkerRunner;
  const workerId = process.env.OVO_WORKER_ID ?? `compact-${process.pid}`;
  const workerEpoch = Date.now();
  let active: (DeliveryOutcome & { kind: 'accepted' }) | undefined;
  state = 'ready';
  detail = 'All required adapters composed; awaiting durable work';

  const report = async () =>
    store.reportWorker({
      workerId,
      ownershipEpoch: workerEpoch,
      leaseMs: 15_000,
      state: state === 'active' ? 'active' : state === 'draining' ? 'draining' : 'ready_idle',
      metadata: { liveDial: true },
    });
  await report();
  const heartbeat = setInterval(
    () =>
      void report().catch((error) => {
        state = 'draining';
        detail = String(error);
        runner.beginDrain();
      }),
    5_000,
  );
  heartbeat.unref();

  const shutdown = async () => {
    state = 'draining';
    runner.beginDrain();
    clearInterval(heartbeat);
    await report().catch(() => undefined);
    active?.lease.stop();
    await active?.protection.release();
    await composition.dispose();
    server.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  while (state !== 'draining') {
    if (active) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    const deliveries: QueueDelivery[] = await queue.receive({
      maxMessages: 1,
      waitSeconds: 20,
      visibilitySeconds: 120,
    });
    for (const delivery of deliveries) {
      await store.reportWorker({
        workerId,
        state: 'reserved',
        ownershipEpoch: workerEpoch,
        leaseMs: 15_000,
      });
      const outcome = await runner.handle(delivery);
      if (outcome.kind === 'accepted') {
        active = outcome;
        state = 'active';
        detail = `Active carrier leg ${outcome.carrierCallId}`;
      } else if (outcome.kind === 'deferred' && outcome.reason.includes('protection')) {
        state = 'draining';
        detail = outcome.reason;
        runner.beginDrain();
      } else {
        state = 'ready';
        detail = outcome.kind;
      }
      await report();
    }
  }
}

main().catch((error: unknown) => {
  state = 'failed';
  detail = error instanceof Error ? error.message : String(error);
  console.error('worker startup failed:', detail);
  process.exitCode = 1;
});
