import { Cap } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import { createOperationsPlugin } from '@winsendotai/ovo-plugin-operations';
import type {
  DurableQueue,
  PostgresOrchestrationStore,
  TelephonyControl,
} from '@winsendotai/ovo-plugin-orchestration';
import {
  RECORDING_SERVICE_KEYS,
  type ProductionRecordingServices,
} from '@winsendotai/ovo-plugin-recordings/production';
import { LocalAesGcmSecretManager, decodeMasterKey } from '@winsendotai/ovo-plugin-secrets';
import { PostgresControlStore } from '@winsendotai/ovo-plugin-storage';
import {
  compose,
  definePlugin,
  loadInstalledSessionExtensions,
  manifestKeys,
  type Composition,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import { createCallRecorderPlugin } from './call-recorder.ts';
import { createWorkerCarrierRuntimePlugin } from './worker-carrier-plugin.ts';
import type { WorkerCarrierRuntime } from './carrier-runtime.ts';
import { ProductionWorkerCostRuntime } from './cost-runtime.ts';
import { createWorkerCostRuntimePlugin } from './cost-runtime-plugin.ts';
import { createWorkerRecordingsPlugin } from './recording-runtime.ts';
import { ecsRuntimeConfig, localProtectionPlugin, readinessPlugin } from './runtime-plugins.ts';
import { WorkerSpeechCacheRuntime } from './speech-cache-runtime.ts';
import { createWorkerRunnerPlugin } from './worker-plugin.ts';
import type { WorkerRunner } from './runner.ts';
import {
  durableAdapterPlugins,
  env,
  openWorkerTelemetry,
  optionalInteger,
  workerRuntimeServices,
} from './worker-environment.ts';

const netManifest = {
  id: 'ovo.worker.node-net',
  version: '1.0.0',
  contractVersion: 2,
  scope: 'process',
  kind: 'host',
  provides: [Cap.net],
  requires: [],
  secretFields: [],
  configSchema: { type: 'object', additionalProperties: false },
} as const;
const netPlugin = definePlugin(netManifest, (ctx) => {
  const port = createNodeNet();
  ctx.effect(() => () => port.close());
  ctx.provide(Cap.net, port);
});

export async function openWorkerProcess() {
  const distribution = await loadDistribution({
    role: 'worker',
    profile: process.env.OVO_DEPLOYMENT_PROFILE === 'fargate' ? 'fargate' : 'compose',
    env: process.env,
  });
  const { definitions: adapters, rows: adapterRows } = durableAdapterPlugins();
  if (process.env.OVO_LIVE_DIAL_ENABLED !== 'true') {
    const composition = await compose(adapterRows, [...adapters, ...distribution.catalog]);
    return { kind: 'dial-disabled' as const, composition };
  }
  const protectionMode = process.env.OVO_PROTECTION_MODE ?? 'ecs';
  const protectionDefinition =
    protectionMode === 'process-lifecycle'
      ? localProtectionPlugin
      : (await import('@winsendotai/ovo-plugin-orchestration')).ecsProtectionPlugin;
  const ecsRuntime = protectionMode === 'process-lifecycle' ? undefined : await ecsRuntimeConfig();
  const workerEndpoint = process.env.OVO_WORKER_ENDPOINT ?? ecsRuntime?.workerEndpoint;
  if (!workerEndpoint) throw new Error('Missing required environment variable OVO_WORKER_ENDPOINT');
  const workerId = process.env.OVO_WORKER_ID ?? `compact-${process.pid}`;
  const workerEpoch = Date.now();
  const databaseUrl = process.env.OVO_CONTROL_DATABASE_URL ?? env('DATABASE_URL');
  const controlStore = await PostgresControlStore.open(databaseUrl);
  const costLedger = new PostgresCostLedger({ connectionString: databaseUrl });
  await costLedger.migrate();
  const extensions = await loadInstalledSessionExtensions(process.env.OVO_PLUGIN_MODULES ?? '[]');
  const speechCache = new WorkerSpeechCacheRuntime();
  const telemetry = await openWorkerTelemetry(
    process.env.OVO_TELEMETRY_DATABASE_URL ?? env('DATABASE_URL'),
    controlStore,
  );
  const secrets = new LocalAesGcmSecretManager(
    controlStore,
    decodeMasterKey(env('OVO_SECRETS_MASTER_KEY')),
    'encrypted-store',
  );
  const recordingsDefinition = createWorkerRecordingsPlugin(controlStore, databaseUrl);
  const callRecorderDefinition = createCallRecorderPlugin(controlStore);
  const costDefinition = createWorkerCostRuntimePlugin({
    ledger: costLedger,
    control: controlStore,
    catalog: distribution.catalog,
    defaults: distribution.defaults,
  });
  const operationsDefinition = createOperationsPlugin({
    organizationId: env('OVO_ORGANIZATION_ID'),
    connectionString: process.env.OVO_OPERATIONS_DATABASE_URL ?? env('DATABASE_URL'),
    maxConnections: optionalInteger('OVO_OPERATIONS_PG_MAX_CONNECTIONS', 1, 20),
  });
  const carrierPlugin = createWorkerCarrierRuntimePlugin({
    catalog: distribution.catalog,
    controlStore,
    secrets,
    defaults: distribution.defaults,
    env: process.env,
    publicBaseUrl: env('OVO_MEDIA_PUBLIC_BASE_URL'),
    routeSecret: env('OVO_INBOUND_ROUTE_SECRET'),
  });
  const carrierDefinition = carrierPlugin.definition;
  const workerRunnerPlugin = createWorkerRunnerPlugin(carrierPlugin.runtime);
  const carrierRows = distribution.processRows.filter((row) => {
    const definition = distribution.catalog.find((plugin) => plugin.manifest.id === row.id);
    return (
      definition &&
      manifestKeys(definition.manifest).provides.some(
        (entry) => entry.key === Cap.carrierControl || entry.key === Cap.carrierIngress,
      )
    );
  });
  const catalog = unique([
    ...distribution.catalog,
    ...adapters,
    protectionDefinition,
    readinessPlugin,
    netPlugin,
    operationsDefinition,
    carrierDefinition,
    callRecorderDefinition,
    costDefinition,
    recordingsDefinition,
    workerRunnerPlugin,
  ]);
  const composition = await compose(
    [
      ...adapterRows,
      { id: protectionDefinition.manifest.id, config: ecsRuntime?.protection ?? {} },
      {
        id: readinessPlugin.manifest.id,
        config: { mediaReadinessUrl: env('OVO_MEDIA_READINESS_URL') },
      },
      { id: netPlugin.manifest.id },
      ...carrierRows,
      { id: operationsDefinition.manifest.id },
      { id: carrierDefinition.manifest.id },
      { id: callRecorderDefinition.manifest.id },
      { id: costDefinition.manifest.id, config: { workerId, requirePolicy: true } },
      { id: recordingsDefinition.manifest.id },
      {
        id: workerRunnerPlugin.manifest.id,
        config: { workerId, workerEndpoint, organizationId: env('OVO_ORGANIZATION_ID') },
      },
    ],
    catalog,
  );
  const store = composition.ctx.get(Cap.orchestrationStore) as PostgresOrchestrationStore;
  const queue = composition.ctx.get(Cap.orchestrationQueue) as DurableQueue;
  const runner = composition.ctx.get(Cap.workerRunner) as WorkerRunner;
  const telephony = composition.ctx.get(Cap.legacyTelephony) as TelephonyControl;
  const carriers = carrierPlugin.runtime();
  const { protection, operations } = workerRuntimeServices(composition.ctx);
  const costs = composition.ctx.get(Cap.workerCostRuntime) as ProductionWorkerCostRuntime;
  const recordings = composition.ctx.get(
    RECORDING_SERVICE_KEYS.production,
  ) as ProductionRecordingServices;
  return {
    kind: 'live' as const,
    composition,
    distribution,
    extensions,
    workerId,
    workerEpoch,
    workerEndpoint,
    store,
    queue,
    runner,
    telephony,
    carriers,
    protection,
    operations,
    costs,
    recordings,
    controlStore,
    costLedger,
    telemetry,
    secrets,
    speechCache,
  };
}

function unique(definitions: readonly PluginDefinition[]): PluginDefinition[] {
  const found = new Map<string, PluginDefinition>();
  for (const definition of definitions) found.set(definition.manifest.id, definition);
  return [...found.values()];
}
