import type { UserDirectory } from './user-directory.ts';
import { type OperationStore } from '@winsendotai/ovo-contracts';
import { Cap } from '@winsendotai/ovo-contracts';
import { priceUsage, summarizeUsage } from '@winsendotai/ovo-plugin-observability';
import { type SecretManager } from '@winsendotai/ovo-plugin-secrets';
import {
  DraftConflictError,
  ReferencedResourceError,
  type ControlStore,
} from '@winsendotai/ovo-plugin-storage';
import { parseApprovedEndpoint } from '@winsendotai/ovo-plugin-tools-http';
import { createMcpConnector } from '@winsendotai/ovo-plugin-tools-mcp';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Authenticator, error, publicIdentity, requireRole } from './auth-service.ts';
import {
  createSessionServicesPlugin,
  mergeCatalog,
  runRelease,
  validateRelease,
} from './release-runtime.ts';
import { registerApiRoutes } from './routes/registry.ts';
import type { InfrastructureService } from './infrastructure-types.ts';
import { API_PRODUCTION_RECORDING_SERVICE_KEY } from './recording-runtime.ts';
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
import { createDefaultReleaseFactory } from './session-factory.ts';
import type { ManagementApiOptions, ManagementApiService, Principal } from './types.ts';
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
const isTls = (request: FastifyRequest) => request.protocol === 'https';
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
        ...(options.usersEnabled ? ['ovo.users'] : []),
        'secretManager',
        'ovo.operation-store',
        'ovo.observability',
        ...(options.fixtureRecordingsEnabled !== false ? ['ovo.recordings'] : []),
        ...(options.productionRecordingsEnabled ? [API_PRODUCTION_RECORDING_SERVICE_KEY] : []),
        ...(options.costLedgerEnabled ? ['ovo.cost-ledger'] : []),
        ...(options.telemetryEnabled ? ['ovo.telemetry'] : []),
        ...(options.evaluationsEnabled ? ['ovo.evaluations'] : []),
        ...(options.operationsEnabled ? ['ovo.operations'] : []),
        ...(options.infrastructureEnabled ? ['ovo.infrastructure'] : []),
        Cap.carrierControl,
        Cap.carrierIngress,
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
      const users = options.usersEnabled ? (ctx.get('ovo.users') as UserDirectory) : undefined;
      for (const identity of options.identities)
        for (const workspaceId of Object.keys(identity.workspaces))
          await store.ensureWorkspace(workspaceId, workspaceId);
      const app = Fastify({
        logger: options.logger
          ? {
              redact: {
                paths: [
                  'req.headers.authorization',
                  'req.headers.cookie',
                  'req.body.token',
                  'req.body.password',
                  'req.body.currentPassword',
                  'req.body.newPassword',
                  'req.body.value',
                ],
                censor: '[REDACTED]',
              },
            }
          : false,
        trustProxy: options.trustedProxy ?? false,
        bodyLimit: 256_000,
      });
      app.addHook('onRequest', async (request, reply) => {
        const path = request.url.split('?')[0];
        if (path === '/health' || path === '/v1/auth/session') return;
        const principal = await auth.authenticateWithUsers(request, users);
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
        ctx,
        app,
        store,
        telemetry: options.telemetryEnabled ? ctx.get('ovo.telemetry') : undefined,
        infrastructure: options.infrastructureEnabled
          ? (ctx.get('ovo.infrastructure') as InfrastructureService)
          : undefined,
        secrets,
        auth,
        users,
        options: {
          ...options,
          createReleasePlugins:
            options.createReleasePlugins ??
            createDefaultReleaseFactory(store, options.defaultSession),
        },
        services,
        createServices,
        catalog,
        distributionDefaults: options.distributionDefaults,
        unavailable: options.unavailable,
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
      registerApiRoutes(routeDependencies);
      await app.ready();
      ctx.provide('managementApi', { app } satisfies ManagementApiService);
      ctx.fiber.effect(() => () => app.close(), 'close management API');
    },
  );
}

function validateMcpEndpoint(endpoint: string) {
  try {
    parseApprovedEndpoint(endpoint, { allowQuery: false });
  } catch {
    throw Object.assign(
      new Error(
        'MCP endpoint must be public HTTPS without URL credentials, fragments or query parameters',
      ),
      { statusCode: 400, code: 'invalid_endpoint' },
    );
  }
}
