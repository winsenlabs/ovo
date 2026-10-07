import { hostname } from 'node:os';
import { Cap, type BackgroundTask, type CapacitySignalPublisher } from '@winsendotai/ovo-contracts';
import { FIRST_PARTY, loadDistribution } from '@winsendotai/ovo-distribution';
import { createLogger, createNodeNet, errorFields } from '@winsendotai/ovo-plugin-kit';
import type { Logger } from '@winsendotai/ovo-contracts';
import { createCostLedgerPlugin } from '@winsendotai/ovo-plugin-ledger';
import {
  EcsServiceReader,
  OutboxPublisher,
  type DurableQueue,
  type PostgresOrchestrationStore,
} from '@winsendotai/ovo-plugin-orchestration';
import {
  createOperationsPlugin,
  OperationsOutboxDispatcher,
  type PostgresOperationsService,
} from '@winsendotai/ovo-plugin-operations';
import { PostgresControlStore, type ControlStore } from '@winsendotai/ovo-plugin-storage';
import { PostgresCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { compose, definePlugin, type Composition } from '@winsendotai/ovo-runtime';
import {
  readDispatcherCapacityInput,
  readInboundReadiness,
  positiveInteger,
} from './dispatcher-capacity.ts';
import { complianceDispositionTask } from './compliance-dispositions.ts';
import { DispatcherLoop, type DispatcherTask } from './dispatcher-loop.ts';
import { publishInboundReadiness } from './inbound-readiness-store.ts';
import { releaseTerminalCalls } from './terminal-calls.ts';

type Environment = Record<string, string | undefined>;

const netPlugin = definePlugin(
  {
    id: 'ovo.dispatcher.node-net',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'host',
    provides: [Cap.net],
    requires: [],
    secretFields: [],
    configSchema: { type: 'object', additionalProperties: false },
  },
  (ctx) => {
    const net = createNodeNet();
    ctx.provide(Cap.net, net);
    ctx.effect(() => () => net.close());
  },
);

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export async function dispatcherIdentity(
  env: Environment,
  fetcher: typeof fetch = fetch,
  log: Logger = createLogger({ service: 'dispatcher' }),
): Promise<string> {
  const uri = env.ECS_CONTAINER_METADATA_URI_V4;
  const fallback = `${hostname()}:${process.pid}`;
  if (uri) {
    try {
      const response = await fetcher(`${uri}/task`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const metadata = (await response.json()) as { TaskARN?: unknown };
        if (typeof metadata.TaskARN === 'string' && metadata.TaskARN) return metadata.TaskARN;
      }
      log.warn('dispatcher_identity_fallback', { status: response.status, identity: fallback });
    } catch (error) {
      // Local identity is the documented fallback; the line says why replicas look local.
      log.warn('dispatcher_identity_fallback', { identity: fallback, ...errorFields(error) });
    }
  }
  return fallback;
}

export async function openDispatcherProcess(input: {
  env: Environment;
  readProvisionedTasks?: () => Promise<number>;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<{ loop: DispatcherLoop; composition: Composition; close(): Promise<void> }> {
  const env = input.env;
  const profile = env.OVO_DEPLOYMENT_PROFILE === 'fargate' ? 'fargate' : 'compose';
  const databaseUrl = required(env, 'DATABASE_URL');
  const organizationId = required(env, 'OVO_ORGANIZATION_ID');
  const identity = await dispatcherIdentity(env);
  const operationsPlugin = createOperationsPlugin({
    organizationId,
    connectionString: databaseUrl,
    config: {
      liveEnabled: env.OVO_LIVE_DIAL_ENABLED === 'true',
      permittedFromNumbers: (env.OVO_PERMITTED_FROM_NUMBERS ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    },
  });
  const ledgerPlugin = createCostLedgerPlugin();
  const distribution = await loadDistribution({
    role: 'dispatcher',
    profile,
    env,
    firstParty: [
      ...FIRST_PARTY,
      {
        package: 'ovo-dispatcher-host',
        roles: ['dispatcher'],
        load: async () => ({ plugins: [operationsPlugin, ledgerPlugin, netPlugin] }),
      },
    ],
  });
  const signalId = `@winsendotai/ovo-plugin-orchestration/${profile === 'fargate' ? 'cloudwatch' : 'log'}-capacity-signal`;
  const signalRows = distribution.processRows.filter(
    (row) =>
      row.id.endsWith('/cloudwatch-capacity-signal') || row.id.endsWith('/log-capacity-signal'),
  );
  if (signalRows.filter((row) => row.id === signalId).length !== 1)
    throw new Error(`Dispatcher profile must select exactly one ${signalId} row`);
  const rows = distribution.processRows.filter(
    (row) => !signalRows.includes(row) || row.id === signalId,
  );
  const logger = createLogger({ service: 'dispatcher', dispatcherId: identity });
  const composition = await compose(rows, distribution.catalog, { scope: 'process', logger });
  let controlStore: ControlStore | undefined;
  let outcomes: PostgresCallOutcomeStore | undefined;
  try {
    const store = composition.get(Cap.orchestrationStore) as PostgresOrchestrationStore;
    const queue = composition.get(Cap.orchestrationQueue) as DurableQueue;
    const operations = composition.get(Cap.operations) as PostgresOperationsService;
    const publisher = composition.get(Cap.capacitySignal) as CapacitySignalPublisher;
    if (
      !store ||
      !queue ||
      !operations ||
      !publisher ||
      !composition.get(Cap.costLedger) ||
      !composition.get(Cap.net)
    )
      throw new Error('Dispatcher profile is missing a required service');
    controlStore = await PostgresControlStore.open(env.OVO_CONTROL_DATABASE_URL ?? databaseUrl);
    const control = controlStore;
    // The workers write each call's disposition here; the compliance sweep reads it back.
    outcomes = await PostgresCallOutcomeStore.open({
      connectionString: env.OVO_CONTROL_DATABASE_URL ?? databaseUrl,
      maxConnections: 1,
    });
    const callOutcomes = outcomes;
    const outbox = new OutboxPublisher(identity, store, queue);
    const campaignOutbox = new OperationsOutboxDispatcher(identity, operations.outbox, {
      async enqueue(job) {
        await store.enqueue({
          id: job.jobId,
          workspaceId: organizationId,
          idempotencyKey: job.idempotencyKey,
          payload: job.payload,
          notBefore: job.notBefore,
        });
      },
    });
    const tasks: DispatcherTask[] = [
      ...[...composition.all(Cap.backgroundTask)].map(([id, value]) => {
        const task = value as BackgroundTask;
        return {
          id,
          intervalMs: task.intervalMs,
          jitterMs: task.jitterMs,
          tick: (signal: AbortSignal) => task.tick(signal),
        };
      }),
      {
        id: 'durable-outbox',
        intervalMs: 1_000,
        async tick(signal) {
          signal.throwIfAborted();
          await Promise.all([
            outbox.flush(),
            campaignOutbox.flush(),
            releaseTerminalCalls(store, control, logger),
          ]);
        },
      },
      complianceDispositionTask({
        operations,
        outcomes: callOutcomes,
        workspaceId: organizationId,
        logger,
      }),
    ];
    const ecsReader =
      !input.readProvisionedTasks && profile === 'fargate'
        ? new EcsServiceReader(
            required(env, 'OVO_ECS_CLUSTER'),
            { workers: required(env, 'OVO_WORKER_SERVICE') },
            { region: required(env, 'AWS_REGION') },
          )
        : undefined;
    const readProvisionedTasks =
      input.readProvisionedTasks ??
      (ecsReader
        ? async () => {
            const service = await ecsReader.read('workers');
            return service.runningCount + service.pendingCount;
          }
        : async () => positiveInteger(env, 'OVO_COMPOSE_WORKERS', 2));
    const loop = new DispatcherLoop({
      tasks,
      readCapacityInput: () =>
        readDispatcherCapacityInput({ store, operations, env, readProvisionedTasks }),
      async publish(signal) {
        await publisher.publish(signal);
        await store.recordCapacitySignal(signal);
      },
      readInboundReadiness: (capacity) => readInboundReadiness({ operations, capacity }),
      publishInboundReadiness: (readiness) => publishInboundReadiness(store.pool, readiness),
      log: input.log,
    });
    return {
      loop,
      composition,
      async close() {
        await loop.stop();
        await control.close();
        await callOutcomes.close();
        await composition.dispose();
      },
    };
  } catch (error) {
    await controlStore?.close();
    await outcomes?.close();
    await composition.dispose();
    throw error;
  }
}
