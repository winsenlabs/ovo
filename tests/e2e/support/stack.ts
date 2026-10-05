import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManagementApi } from '../../../apps/api/src/bootstrap.ts';
import { startDispatcher } from '../../../apps/dispatcher/src/main.ts';
import { startGateway } from '../../../apps/media-gateway/src/startup.ts';
import { createWorkerHealthServer } from '../../../apps/worker/src/worker-health.ts';
import { runWorkerLoop, type WorkerStatus } from '../../../apps/worker/src/worker-loop.ts';
import { PostgresOrchestrationStore } from '../../../packages/plugin-orchestration/src/index.ts';
import { renderServiceEnv } from './compose-env.ts';
import { goLiveComposeVariables } from './deployment-env.ts';
import { startFakeSqs } from './fake-providers.ts';
import { OPERATOR_TOKEN } from './operator-setup.ts';

/** Variables Compose leaves to code defaults that a host-local run must still bind elsewhere. */
const HOST_BINDINGS = new Set(['OVO_MEDIA_HOST', 'PORT']);

/**
 * A service's Compose environment with only its addresses moved to this host. Every override must
 * replace a value Compose already supplies (or a host binding), so a variable the deployment
 * forgot cannot be papered over here: the service fails to start, as it would in Compose.
 */
export function hostEnv(
  service: string,
  variables: Record<string, string>,
  addresses: Record<string, string>,
): Record<string, string> {
  const rendered = renderServiceEnv(service, variables);
  for (const key of Object.keys(addresses))
    if (!(key in rendered) && !HOST_BINDINGS.has(key))
      throw new Error(`Compose does not give ${service} ${key}; fix compose.yaml, not this test`);
  return { ...rendered, ...addresses };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type LiveStack = Awaited<ReturnType<typeof startLiveStack>>;

/**
 * One compact installation in this process: the management API, the media gateway, the
 * dispatcher and one inbound-capable worker, each started through its production entry point with the environment
 * compose.yaml renders for it, sharing a fresh migrated schema in real PostgreSQL.
 */
export async function startLiveStack(postgresUrl: string) {
  const schema = `live_path_${randomUUID().replaceAll('-', '')}`;
  const admin = new PostgresOrchestrationStore({ connectionString: postgresUrl, max: 1 });
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = new URL(postgresUrl);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const variables = goLiveComposeVariables(databaseUrl.href);
  const cleanups: (() => Promise<unknown>)[] = [
    async () => {
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close();
    },
  ];
  const close = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  };
  try {
    const sqs = await startFakeSqs();
    cleanups.push(() => sqs.close());
    const recordings = await mkdtemp(join(tmpdir(), 'ovo-live-path-'));
    cleanups.push(() => rm(recordings, { recursive: true, force: true }));
    const queue = {
      OVO_SQS_ENDPOINT: sqs.origin,
      OVO_QUEUE_URL: `${sqs.origin}/000000000000/ovo-jobs`,
    };

    const apiEnv = renderServiceEnv('api', variables);
    const organizationId = apiEnv.OVO_ORGANIZATION_ID!;
    const { app, composition } = await buildManagementApi({
      identities: [
        {
          id: 'operator',
          label: 'Operator',
          token: OPERATOR_TOKEN,
          defaultWorkspaceId: organizationId,
          workspaces: { [organizationId]: 'admin' },
        },
      ],
      sessionSecret: apiEnv.OVO_SESSION_SECRET!,
      storageAdapter: 'postgres',
      controlDatabaseUrl: apiEnv.DATABASE_URL,
      secretBackend: 'encrypted-store',
      secretsMasterKey: apiEnv.OVO_SECRETS_MASTER_KEY,
      carrierPublicBaseUrl: apiEnv.OVO_MEDIA_PUBLIC_BASE_URL,
      inboundRouteSecret: apiEnv.OVO_INBOUND_ROUTE_SECRET,
      operations: { environment: apiEnv },
      requireTlsForSecrets: false,
      logger: false,
    });
    cleanups.push(async () => {
      await app.close();
      await composition.dispose();
    });

    const gatewayPort = await freePort();
    const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const gateway = await startGateway({
      env: hostEnv('gateway', variables, {
        ...queue,
        OVO_MEDIA_HOST: '127.0.0.1',
        OVO_MEDIA_PORT: String(gatewayPort),
      }),
    });
    cleanups.push(() => gateway.close());

    const dispatcher = await startDispatcher({
      env: hostEnv('dispatcher', variables, {
        ...queue,
        OVO_DLQ_URL: `${sqs.origin}/000000000000/ovo-jobs-dlq`,
      }),
      host: '127.0.0.1',
      port: await freePort(),
    });
    cleanups.push(() => dispatcher.close());

    const workerPort = await freePort();
    const workerEnv = hostEnv('worker-1', variables, {
      ...queue,
      PORT: String(workerPort),
      OVO_MEDIA_GATEWAY_WS_URL: `ws://127.0.0.1:${gatewayPort}/worker`,
      OVO_MEDIA_READINESS_URL: `${gatewayOrigin}/health`,
      OVO_WORKER_ENDPOINT: `ws://127.0.0.1:${workerPort}/internal/media`,
      OVO_RECORDINGS_DIRECTORY: recordings,
    });
    // The worker reads process.env; this test file runs in its own process.
    Object.assign(process.env, workerEnv);
    const status: WorkerStatus = { state: 'starting', detail: 'initializing' };
    const server = createWorkerHealthServer(workerPort, () => status);
    let stopWorker = () => undefined as void;
    const loop = runWorkerLoop({
      status,
      server,
      registerShutdown: (callback) => (stopWorker = callback),
    }).catch((error: unknown) => {
      status.state = 'failed';
      status.detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    });
    cleanups.push(async () => {
      stopWorker();
      await loop;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    const db = new PostgresOrchestrationStore({ connectionString: databaseUrl.href, max: 2 });
    cleanups.push(() => db.close());
    return {
      app,
      gateway: { origin: gatewayOrigin, publicBaseUrl: variables.OVO_MEDIA_PUBLIC_BASE_URL! },
      worker: { id: workerEnv.OVO_WORKER_ID!, status },
      /** Reads the installation's schema. */
      db: db.pool,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
