import { Cap, type CarrierIngress } from '@winsendotai/ovo-contracts';
import {
  FIRST_PARTY,
  loadDistribution,
  type CatalogEntry,
  type LoadedDistribution,
} from '@winsendotai/ovo-distribution';
import { createLogger, createNodeNet, logFailure } from '@winsendotai/ovo-plugin-kit';
import {
  createMediaGatewayPlugin,
  createMediaRouteResolverPlugin,
  MEDIA_PLUGIN_IDS,
  MEDIA_SERVICE_KEYS,
  type MediaGateway,
  type MediaRouteResolver,
} from '@winsendotai/ovo-plugin-media';
import { PostgresOperationsService } from '@winsendotai/ovo-plugin-operations';
import { PostgresOrchestrationStore } from '@winsendotai/ovo-plugin-orchestration';
import {
  compose,
  definePlugin,
  type Composition,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import { createGatewayHost, type GatewayHostOptions } from './gateway-host.ts';
import { installInboundCarriers } from './inbound-carrier-installation.ts';

const GATEWAY_NET_PLUGIN_ID = 'ovo.gateway.node-net';
const GATEWAY_INFRA_PACKAGES = [
  '@winsendotai/ovo-plugin-storage',
  '@winsendotai/ovo-plugin-secrets',
] as const;

/** The distribution owns these dependencies; gateway startup composes their definitions. */
export async function gatewayInfrastructureDefinitions(
  entries: readonly CatalogEntry[] = FIRST_PARTY,
): Promise<[PluginDefinition, PluginDefinition]> {
  const definitions: PluginDefinition[] = [];
  for (const packageName of GATEWAY_INFRA_PACKAGES) {
    const entry = entries.find((candidate) => candidate.package === packageName);
    if (!entry) throw new Error(`Gateway infrastructure catalog entry is missing: ${packageName}`);
    const loaded = (await entry.load()) as { plugins?: readonly PluginDefinition[] };
    const definition = loaded.plugins?.find((plugin) => plugin.manifest.id === packageName);
    if (!definition) throw new Error(`Gateway infrastructure plugin is missing: ${packageName}`);
    definitions.push(definition);
  }
  return definitions as [PluginDefinition, PluginDefinition];
}
const hostManifest = {
  version: '1.0.0',
  contractVersion: 2,
  scope: 'process',
  kind: 'infra',
  requires: [],
  configSchema: { type: 'object', additionalProperties: false },
  secretFields: [],
} as const;
const netPlugin = definePlugin(
  {
    ...hostManifest,
    id: GATEWAY_NET_PLUGIN_ID,
    provides: [Cap.net],
  },
  (ctx) => {
    const net = createNodeNet();
    ctx.provide(Cap.net, net);
    ctx.effect(() => () => net.close());
  },
);

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('invalid positive integer environment value');
  return parsed;
}

function drainTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  if (env.OVO_MEDIA_DRAIN_TIMEOUT_MS !== undefined)
    return integer(env.OVO_MEDIA_DRAIN_TIMEOUT_MS, 1);
  const deregistrationSeconds = integer(env.OVO_MEDIA_DEREGISTRATION_DELAY_SECONDS, 300);
  return Math.max(100, deregistrationSeconds * 1_000 - 30_000);
}

export interface GatewayRuntime {
  composition: Composition;
  gateway: MediaGateway;
  close(): Promise<void>;
}

/** Production startup, also callable by a loopback integration test with an installed fixture. */
export async function startGateway(
  input: {
    env?: Readonly<Record<string, string | undefined>>;
    distribution?: LoadedDistribution;
  } = {},
): Promise<GatewayRuntime> {
  const env = input.env ?? process.env;
  const logger = createLogger({ service: 'media-gateway' });
  const profile = env.OVO_DEPLOYMENT_PROFILE === 'fargate' ? 'fargate' : 'compose';
  const publicBaseUrl = required(env, 'OVO_MEDIA_PUBLIC_BASE_URL');
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Carrier public base URL must be https without credentials or query');
  const databaseUrl = required(env, 'DATABASE_URL');
  const routeSecret = required(env, 'OVO_INBOUND_ROUTE_SECRET');
  const workerToken = required(env, 'OVO_MEDIA_WORKER_TOKEN');
  const organizationId = required(env, 'OVO_ORGANIZATION_ID');
  const distribution =
    input.distribution ?? (await loadDistribution({ role: 'gateway', profile, env }));
  const [storagePlugin, secretsPlugin] = await gatewayInfrastructureDefinitions();
  const store = new PostgresOrchestrationStore({ connectionString: databaseUrl });
  const operations = new PostgresOperationsService({
    connectionString: databaseUrl,
    organizationId,
    config: {
      liveEnabled: env.OVO_LIVE_DIAL_ENABLED === 'true',
      permittedFromNumbers: (env.OVO_PERMITTED_FROM_NUMBERS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    },
  });
  let composition: Composition | undefined;
  try {
    await store.migrate();
    await operations.migrate();
    const environmentCarrierId = installInboundCarriers(operations, distribution, env);
    operations.inboundGateway.assertArmed();
    const resolver: MediaRouteResolver = {
      authenticateSessionRoute: store.authenticateSessionRoute.bind(store),
      resolveSessionRoute: store.resolveSessionRoute.bind(store),
      bindCarrierCallId: store.bindCarrierCallId.bind(store),
      recordCarrierCallIdMismatch: store.recordCarrierCallIdMismatch.bind(store),
    };
    let host: ReturnType<typeof createGatewayHost> | undefined;
    const hostFor = (carrierId: string, bindingId: string) => {
      if (!composition) throw new Error('Gateway composition is not ready');
      host ??= createGatewayHost({
        publicBaseUrl,
        routeSecret,
        store,
        operations,
        distribution,
        control: composition.ctx.get(Cap.controlStore) as GatewayHostOptions['control'],
        secrets: composition.ctx.get(Cap.secretManager) as GatewayHostOptions['secrets'],
        ingresses: [...composition.all(Cap.carrierIngress).values()] as CarrierIngress[],
        environmentCarrierId,
        env,
      });
      return host.hostFor(carrierId, bindingId);
    };
    const resolverPlugin = createMediaRouteResolverPlugin(resolver);
    const gatewayPlugin = createMediaGatewayPlugin({ workerToken }, { hostFor, logger });
    const extra = [storagePlugin, secretsPlugin, netPlugin, resolverPlugin, gatewayPlugin];
    const catalog = [
      ...distribution.catalog.filter(
        (definition) => !extra.some((entry) => entry.manifest.id === definition.manifest.id),
      ),
      ...extra,
    ];
    composition = await compose(
      [
        ...distribution.processRows.filter(
          (row) => !extra.some((entry) => entry.manifest.id === row.id),
        ),
        { id: storagePlugin.manifest.id, config: { adapter: 'postgres', databaseUrl } },
        {
          id: secretsPlugin.manifest.id,
          config: {
            backend:
              env.OVO_SECRETS_BACKEND ??
              (profile === 'fargate' ? 'aws-secrets-manager' : 'encrypted-store'),
            masterKey: env.OVO_SECRETS_MASTER_KEY,
            region: env.AWS_REGION,
          },
        },
        { id: netPlugin.manifest.id },
        { id: MEDIA_PLUGIN_IDS.routeResolver },
        {
          id: MEDIA_PLUGIN_IDS.gateway,
          config: {
            publicBaseUrl,
            host: env.OVO_MEDIA_HOST ?? '0.0.0.0',
            port: integer(env.OVO_MEDIA_PORT, 8080),
            maxMessageBytes: integer(env.OVO_MEDIA_MAX_MESSAGE_BYTES, 65_536),
            maxAudioFrameBytes: integer(env.OVO_MEDIA_MAX_AUDIO_FRAME_BYTES, 8_192),
            maxBufferedBytes: integer(env.OVO_MEDIA_MAX_BUFFERED_BYTES, 262_144),
            preAcceptBufferMs:
              env.OVO_MEDIA_PRE_ACCEPT_MS === undefined
                ? undefined
                : integer(env.OVO_MEDIA_PRE_ACCEPT_MS, 3_000),
            maxPendingFrames:
              env.OVO_MEDIA_MAX_PENDING_FRAMES === undefined
                ? undefined
                : integer(env.OVO_MEDIA_MAX_PENDING_FRAMES, 25),
            handshakeTimeoutMs: integer(env.OVO_MEDIA_HANDSHAKE_TIMEOUT_MS, 5_000),
            idleTimeoutMs: integer(env.OVO_MEDIA_IDLE_TIMEOUT_MS, 30_000),
            drainTimeoutMs: drainTimeoutMs(env),
          },
        },
      ],
      catalog,
    );
    const gateway = composition.ctx.get(MEDIA_SERVICE_KEYS.gateway) as MediaGateway;
    await gateway.listen();
    const active = composition;
    return {
      composition: active,
      gateway,
      async close() {
        await active.dispose();
        await operations.close();
        await store.close();
      },
    };
  } catch (error) {
    await composition?.dispose().catch(logFailure(logger, 'gateway_startup_cleanup_failed'));
    await operations.close();
    await store.close();
    throw error;
  }
}
