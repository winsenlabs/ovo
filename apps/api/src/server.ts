import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentConfig,
  type Behavior,
  type OperationStore,
  type SecretResolver,
} from '@winsendotai/ovo-contracts';
import { createBehaviorPluginCatalog } from '@winsendotai/ovo-behaviors';
import {
  observabilityPlugin,
  priceUsage,
  summarizeUsage,
  type PriceCard,
} from '@winsendotai/ovo-plugin-observability';
import {
  compose,
  definePlugin,
  resolveGraph,
  type Composition,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';
import {
  DraftConflictError,
  ReferencedResourceError,
  storagePlugin,
  type AgentDraft,
  type ControlStore,
  type McpConnection,
  type ReleaseRecord,
  type Role,
} from '@winsendotai/ovo-plugin-storage';
import { secretsPlugin, type SecretManager } from '@winsendotai/ovo-plugin-secrets';
import { createMcpConnector } from '@winsendotai/ovo-plugin-tools-mcp';
import { dirname, join } from 'node:path';
import { recordingsPlugin, type RecordingArchive } from '@winsendotai/ovo-plugin-recordings';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerAgentsRoutes } from './routes/agents.ts';
import { registerCredentialsRoutes } from './routes/credentials.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { registerSimulationRoutes } from './routes/simulation.ts';
import { registerInspectionRoutes } from './routes/inspection.ts';
import { registerRecordingRoutes } from './routes/recordings.ts';
import { Authenticator, error, publicIdentity, requireRole } from './auth-service.ts';
import {
  AgentBody,
  ApprovalBody,
  CredentialBody,
  EvaluationBody,
  Id,
  McpBody,
  PluginSelection,
  ProviderBindingBody,
  SimulationBody,
  UsageBody,
} from './schemas.ts';
import {
  createSessionServicesPlugin,
  mergeCatalog,
  runRelease,
  validateRelease,
} from './release-runtime.ts';
import type {
  BootstrapIdentity,
  BuildApiOptions,
  ManagementApiOptions,
  ManagementApiService,
  Principal,
} from './types.ts';
export type {
  BootstrapIdentity,
  BuildApiOptions,
  ManagementApiOptions,
  ManagementApiService,
} from './types.ts';

const etag = (version: number) => `"${version}"`;
function expectedVersion(request: FastifyRequest) {
  const value = request.headers['if-match'];
  if (typeof value !== 'string')
    throw Object.assign(new Error('If-Match is required'), {
      statusCode: 428,
      code: 'precondition_required',
    });
  return Number(value.replaceAll('"', ''));
}
const queryPage = (request: FastifyRequest) => {
  const query = request.query as { limit?: string | number; cursor?: string };
  return { limit: query.limit === undefined ? 50 : Number(query.limit), cursor: query.cursor };
};
const isTls = (request: FastifyRequest) =>
  request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
function rejectEmbeddedSecrets(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|token|password|authorization|api.?key|credential/i.test(key))
      throw Object.assign(new Error('Embedded secrets are not allowed'), {
        statusCode: 400,
        code: 'embedded_secret',
      });
    rejectEmbeddedSecrets(child);
  }
}

export function createManagementApiPlugin(options: ManagementApiOptions): PluginDefinition {
  const catalog = options.pluginCatalog ?? [];
  return definePlugin(
    {
      id: '@winsendotai/ovo-api',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      provides: ['managementApi'],
      requires: [
        'controlStore',
        'secretManager',
        'ovo.operation-store',
        'ovo.observability',
        'ovo.recordings',
      ],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const store = ctx.get('controlStore') as ControlStore,
        secrets = ctx.get('secretManager') as SecretManager;
      const createServices = (agentId?: string) =>
        createSessionServicesPlugin(
          ctx.get('ovo.operation-store') as OperationStore,
          agentId ? secrets.forAgent(agentId) : secrets,
          ctx.get('ovo.observability'),
        );
      const services = createServices();
      const auth = new Authenticator(options);
      for (const identity of options.identities)
        for (const workspaceId of Object.keys(identity.workspaces))
          store.ensureWorkspace(workspaceId, workspaceId);
      const app = Fastify({
        logger: options.logger
          ? {
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'req.body.token',
                  'req.body.value',
                ],
                censor: '[REDACTED]',
              },
            }
          : false,
        trustProxy: true,
        bodyLimit: 256_000,
      });
      app.addHook('onRequest', async (request, reply) => {
        const path = request.url.split('?')[0];
        if (path === '/health' || path === '/v1/auth/session') return;
        const principal = auth.authenticate(request);
        if (!principal) return error(reply, 401, 'unauthorized', 'Authentication required');
        (request as FastifyRequest & { principal?: Principal }).principal = principal;
      });
      app.setErrorHandler((caught, request, reply) => {
        const thrown = caught as Error & { statusCode?: number; code?: string };
        if (thrown instanceof z.ZodError)
          return error(reply, 400, 'validation_error', 'Request validation failed', {
            issues: thrown.issues,
          });
        if (thrown instanceof DraftConflictError)
          return error(reply, 409, 'draft_conflict', thrown.message, { current: thrown.current });
        if (thrown instanceof ReferencedResourceError)
          return error(reply, 409, 'resource_referenced', thrown.message, thrown.references);
        if (thrown.statusCode && thrown.statusCode < 500)
          return error(reply, thrown.statusCode, thrown.code ?? 'request_error', thrown.message);
        request.log.error({ err: thrown }, 'request failed');
        return error(reply, 500, 'internal_error', 'Request failed');
      });

      const routeDependencies = {
        app,
        store,
        secrets,
        auth,
        options,
        services,
        createServices,
        catalog,
        error,
        publicIdentity,
        requireRole,
        queryPage,
        AgentBody,
        etag,
        z,
        Id,
        expectedVersion,
        PluginSelection,
        randomUUID,
        mergeCatalog,
        validateRelease,
        isTls,
        CredentialBody,
        ProviderBindingBody,
        rejectEmbeddedSecrets,
        McpBody,
        validateMcpEndpoint,
        createMcpConnector,
        ApprovalBody,
        SimulationBody,
        runRelease,
        EvaluationBody,
        UsageBody,
        priceUsage,
        summarizeUsage,
      };
      registerAuthRoutes(routeDependencies);

      registerAgentsRoutes(routeDependencies);

      registerCredentialsRoutes(routeDependencies);

      registerMcpRoutes(routeDependencies);

      registerSimulationRoutes(routeDependencies);

      registerInspectionRoutes(routeDependencies);
      registerRecordingRoutes({
        app,
        store,
        recordings: ctx.get('ovo.recordings') as RecordingArchive,
        requireRole,
        error,
      });

      await app.ready();
      ctx.provide('managementApi', { app } satisfies ManagementApiService);
      ctx.fiber.effect(() => () => app.close(), 'close management API');
    },
  );
}

function validateMcpEndpoint(endpoint: string) {
  const url = new URL(endpoint),
    localDev =
      process.env.NODE_ENV !== 'production' &&
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !localDev) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw Object.assign(
      new Error(
        'MCP endpoint must be a credential-free HTTPS URL (localhost HTTP is development-only)',
      ),
      { statusCode: 400, code: 'invalid_endpoint' },
    );
}

export async function buildManagementApi(
  options: BuildApiOptions,
): Promise<{ app: FastifyInstance; composition: Composition }> {
  if (!options.identities.length) throw new Error('At least one bootstrap identity is required');
  const behaviorCatalog = createBehaviorPluginCatalog(),
    apiPlugin = createManagementApiPlugin({
      ...options,
      pluginCatalog: [...behaviorCatalog, ...(options.pluginCatalog ?? [])],
    }),
    catalog = [
      storagePlugin,
      secretsPlugin,
      observabilityPlugin,
      recordingsPlugin,
      ...behaviorCatalog,
      ...(options.pluginCatalog ?? []),
      apiPlugin,
    ];
  const composition = await compose(
    [
      { id: storagePlugin.manifest.id, config: { filename: options.databaseFile } },
      {
        id: secretsPlugin.manifest.id,
        config: {
          backend: options.secretBackend ?? 'local',
          masterKey: options.secretsMasterKey,
          region: options.awsRegion,
        },
      },
      { id: observabilityPlugin.manifest.id },
      {
        id: recordingsPlugin.manifest.id,
        config: {
          backend: 'local',
          directory:
            options.recordingDirectory ?? join(dirname(options.databaseFile), '.recordings'),
        },
      },
      { id: apiPlugin.manifest.id },
    ],
    catalog,
  );
  const service = composition.ctx.get('managementApi') as ManagementApiService;
  return { app: service.app, composition };
}

export function bootstrapIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): BootstrapIdentity {
  if (!env.OVO_ADMIN_TOKEN) throw new Error('OVO_ADMIN_TOKEN is required');
  const workspaceId = env.OVO_ADMIN_WORKSPACE_ID ?? 'local';
  return {
    id: env.OVO_ADMIN_ID ?? 'local-admin',
    label: env.OVO_ADMIN_LABEL ?? 'Local administrator',
    token: env.OVO_ADMIN_TOKEN,
    defaultWorkspaceId: workspaceId,
    workspaces: { [workspaceId]: 'admin' },
  };
}

export function sessionSecretFromEnv(
  identity: BootstrapIdentity,
  env: NodeJS.ProcessEnv = process.env,
) {
  return (
    env.OVO_SESSION_SECRET ??
    createHash('sha256').update(`ovo-session:${identity.token}`).digest('hex')
  );
}
