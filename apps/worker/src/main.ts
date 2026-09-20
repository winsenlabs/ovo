import { compose, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  postgresOrchestrationPlugin,
  sqsOrchestrationPlugin,
  type DurableQueue,
  type PostgresOrchestrationStore,
  type QueueDelivery,
  type TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import { twilioTelephonyPlugin } from '@winsendotai/ovo-plugin-telephony-twilio';
import { PostgresControlStore } from '@winsendotai/ovo-plugin-storage';
import { LocalAesGcmSecretManager, decodeMasterKey } from '@winsendotai/ovo-plugin-secrets';
import { createOperationsPlugin } from '@winsendotai/ovo-plugin-operations';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import { loadInstalledSessionExtensions } from '@winsendotai/ovo-plugin-session';
import {
  RECORDING_SERVICE_KEYS,
  type ProductionRecordingServices,
} from '@winsendotai/ovo-plugin-recordings/production';
import {
  ProductionWorkerCostRuntime,
  WorkerSpeechCacheRuntime,
  createCallRecorderPlugin,
  createWorkerCostRuntimePlugin,
  terminateActiveSession,
  workerRunnerPlugin,
  type DeliveryOutcome,
  type WorkerRunner,
} from './index.ts';
import { ecsRuntimeConfig, localProtectionPlugin, readinessPlugin } from './runtime-plugins.ts';
import { createWorkerRecordingsPlugin, recordingRetentionDays } from './recording-runtime.ts';
import { createWorkerHealthServer } from './worker-health.ts';
import {
  env,
  openWorkerTelemetry,
  optionalInteger,
  workerHandoffProvider,
  workerRuntimeServices,
} from './worker-environment.ts';
import { createInboundWorkerRuntime } from './inbound-runtime.ts';
import { WorkerReporter } from './worker-reporter.ts';
import { createProductionWorkerMediaRuntime } from './worker-media-bootstrap.ts';

let state: 'starting' | 'dial-disabled' | 'ready' | 'active' | 'draining' | 'failed' = 'starting';
let detail = 'initializing';
const server = createWorkerHealthServer(Number(process.env.PORT ?? 4100), () => ({
  state,
  detail,
}));

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
        endpoint: process.env.OVO_SQS_ENDPOINT || undefined,
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
  const ecsRuntime = protectionMode === 'process-lifecycle' ? undefined : await ecsRuntimeConfig();
  const protectionConfig = ecsRuntime?.protection ?? {};
  const workerEndpoint =
    process.env.OVO_WORKER_ENDPOINT ??
    ecsRuntime?.workerEndpoint ??
    (() => {
      throw new Error('Missing required environment variable OVO_WORKER_ENDPOINT');
    })();
  const workerId = process.env.OVO_WORKER_ID ?? `compact-${process.pid}`;
  const workerEpoch = Date.now();
  const controlDatabaseUrl = process.env.OVO_CONTROL_DATABASE_URL ?? env('DATABASE_URL');
  const controlStore = await PostgresControlStore.open(controlDatabaseUrl);
  const costLedger = new PostgresCostLedger({ connectionString: controlDatabaseUrl });
  await costLedger.migrate();
  const installedExtensions = await loadInstalledSessionExtensions(
    process.env.OVO_PLUGIN_MODULES ?? '[]',
  );
  const speechCache = new WorkerSpeechCacheRuntime();
  const telemetry = await openWorkerTelemetry(
    process.env.OVO_TELEMETRY_DATABASE_URL ?? env('DATABASE_URL'),
    controlStore,
  );
  const recordingsDefinition = createWorkerRecordingsPlugin(controlStore, controlDatabaseUrl);
  const callRecorderDefinition = createCallRecorderPlugin(controlStore);
  const costRuntimeDefinition = createWorkerCostRuntimePlugin({
    ledger: costLedger,
    control: controlStore,
  });
  const mediaPublicBaseUrl = new URL(env('OVO_MEDIA_PUBLIC_BASE_URL'));
  const operationsDefinition = createOperationsPlugin({
    organizationId: env('OVO_ORGANIZATION_ID'),
    connectionString: process.env.OVO_OPERATIONS_DATABASE_URL ?? env('DATABASE_URL'),
    maxConnections: optionalInteger('OVO_OPERATIONS_PG_MAX_CONNECTIONS', 1, 20),
    handoffProvider: workerHandoffProvider(),
  });
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
      id: operationsDefinition.manifest.id,
      config: {},
    },
    { id: callRecorderDefinition.manifest.id, config: {} },
    { id: costRuntimeDefinition.manifest.id, config: { workerId, requirePolicy: true } },
    { id: recordingsDefinition.manifest.id, config: {} },
    {
      id: workerRunnerPlugin.manifest.id,
      config: {
        workerId,
        workerEndpoint,
        organizationId: env('OVO_ORGANIZATION_ID'),
        streamUrl: new URL('/twilio/media', mediaPublicBaseUrl).toString(),
        statusCallbackUrl: new URL('/twilio/status', mediaPublicBaseUrl).toString(),
      },
    },
  ];
  const composition = await compose(rows, [
    ...catalog,
    protectionDefinition,
    readinessPlugin,
    twilioTelephonyPlugin,
    operationsDefinition,
    callRecorderDefinition,
    costRuntimeDefinition,
    recordingsDefinition,
    workerRunnerPlugin,
  ]);
  const store = composition.ctx.get('orchestration.store') as PostgresOrchestrationStore;
  const queue = composition.ctx.get('orchestration.queue') as DurableQueue;
  const runner = composition.ctx.get('worker.runner') as WorkerRunner;
  const telephony = composition.ctx.get('telephony.control') as TelephonyControl;
  const { protection, operations } = workerRuntimeServices(composition.ctx);
  const costRuntime = composition.ctx.get('worker.cost-runtime') as ProductionWorkerCostRuntime;
  const recordings = composition.ctx.get(
    RECORDING_SERVICE_KEYS.production,
  ) as ProductionRecordingServices;
  const secrets = new LocalAesGcmSecretManager(
    controlStore,
    decodeMasterKey(env('OVO_SECRETS_MASTER_KEY')),
    'encrypted-store',
  );
  const inboundRuntime = createInboundWorkerRuntime(
    process.env.OVO_INBOUND_CAPACITY_ENABLED === 'true',
    {
      workerId,
      workerEndpoint,
      generation: workerEpoch,
      protection,
      operations,
      store,
      telephony,
      costs: costRuntime,
      onProtectionLost: (reason) => {
        state = 'draining';
        detail = reason;
        runner.beginDrain();
      },
      onSessionActive: (jobId) => {
        state = 'active';
        detail = `Active inbound job ${jobId}`;
      },
      onSessionIdle: () => {
        state = 'ready';
        detail = 'Inbound session closed';
      },
    },
  );
  let active: (DeliveryOutcome & { kind: 'accepted' }) | undefined;
  const mediaRuntime = createProductionWorkerMediaRuntime({
    gatewayUrl: env('OVO_MEDIA_GATEWAY_WS_URL'),
    gatewayToken: env('OVO_MEDIA_WORKER_TOKEN'),
    workerId,
    onDisconnect: (reason) => {
      state = 'draining';
      detail = `media-gateway:${reason}`;
      runner.beginDrain();
      if (active)
        void terminateActiveSession({
          active,
          reason: 'media-gateway-disconnected',
          workerId,
          store,
          telephony,
        });
    },
    store,
    controlStore,
    secrets,
    telemetry,
    costs: costRuntime,
    extensions: installedExtensions,
    recordings: recordings.live,
    recordingRetentionDays: recordingRetentionDays(),
    speechCache,
    telephony,
    inbound: inboundRuntime,
  });
  await mediaRuntime.connect();
  await inboundRuntime?.start();
  state = 'ready';
  detail = 'All required adapters composed; awaiting durable work';

  const reporter = new WorkerReporter({
    store,
    workerId,
    ownershipEpoch: workerEpoch,
    state: () => state,
    onFailure: (error) => {
      state = 'draining';
      detail = String(error);
      runner.beginDrain();
    },
  });
  await reporter.start();

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      state = 'draining';
      runner.beginDrain();
      await reporter.stop();
      if (active) {
        await terminateActiveSession({
          active,
          reason: 'worker-shutdown',
          workerId,
          store,
          telephony,
        });
        active.lease.stop();
        await active.protection.release();
      }
      await inboundRuntime?.close();
      await mediaRuntime.close('worker-shutdown');
      await telemetry.close();
      speechCache.close();
      await costLedger.close();
      await controlStore.close();
      await composition.dispose();
      server.close();
    })());
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());

  while (state !== 'draining') {
    if (active) {
      const route = await store.getSessionRoute(active.jobId);
      if (!route) {
        state = 'draining';
        detail = 'active-session-route-missing';
        runner.beginDrain();
        continue;
      }
      if (route.terminalAt) {
        active.lease.stop();
        await active.protection.release();
        await mediaRuntime.closeSession(route.sessionId, `carrier terminal: ${route.status}`);
        await costRuntime.finalize(active.jobId);
        const job = await store.get(active.jobId);
        if (job) {
          const callId =
            typeof job.payload.callId === 'string' && job.payload.callId
              ? job.payload.callId
              : job.id;
          try {
            await controlStore.finishCall(job.workspaceId, callId, route.status);
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            continue;
          }
        }
        await store.releaseTerminalSession(active.jobId);
        active = undefined;
        await inboundRuntime?.resume();
        state = 'ready';
        detail = 'terminal session released';
        await reporter.report();
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    const deliveries: QueueDelivery[] = await queue.receive({
      maxMessages: 1,
      waitSeconds: 20,
      visibilitySeconds: 120,
    });
    for (const delivery of deliveries) {
      if (inboundRuntime && !(await inboundRuntime.suspendForOutbound())) {
        detail = 'Inbound capacity is reserved; deferred outbound delivery';
        continue;
      }
      await reporter.reportReserved();
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
        await inboundRuntime?.resume();
      }
      await reporter.report();
    }
  }
  await shutdown();
}

main().catch((error: unknown) => {
  state = 'failed';
  detail = error instanceof Error ? error.message : String(error);
  console.error('worker startup failed:', detail);
  process.exitCode = 1;
});
