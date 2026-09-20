import { type OperationStore } from '@winsendotai/ovo-contracts';
import { type CostLedgerService } from '@winsendotai/ovo-plugin-ledger';
import { priceUsage, summarizeUsage } from '@winsendotai/ovo-plugin-observability';
import { type RecordingArchive } from '@winsendotai/ovo-plugin-recordings';
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
import { registerAgentsRoutes } from './routes/agents.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerCostRoutes } from './routes/cost.ts';
import { registerCredentialsRoutes } from './routes/credentials.ts';
import { registerInspectionRoutes } from './routes/inspection.ts';
import { registerMcpRoutes } from './routes/mcp.ts';
import { registerReadinessRoutes } from './routes/readiness.ts';
import { registerPerformanceRoutes } from './routes/performance.ts';
import { registerOperationsRoutes } from './routes/operations.ts';
import { registerInfrastructureRoutes } from './routes/infrastructure.ts';
import type { InfrastructureService } from './infrastructure-types.ts';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import { registerRecordingLifecycleRoutes } from './routes/recording-lifecycle.ts';
import {
  API_PRODUCTION_RECORDING_SERVICE_KEY,
  getProductionRecordingServices,
} from './recording-runtime.ts';
import { registerEvaluationDatasetRoutes } from './routes/evaluation-datasets.ts';
import { EVALUATION_FIXTURE_BINDING_VERSION } from './evaluation-runtime.ts';
import type { PostgresEvaluationService } from '@winsendotai/ovo-plugin-evaluations';
import type { PerformanceService } from '@winsendotai/ovo-plugin-observability';
import { registerRecordingRoutes } from './routes/recordings.ts';
import { registerSimulationRoutes } from './routes/simulation.ts';
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
          await store.ensureWorkspace(workspaceId, workspaceId);
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
        trustProxy: options.trustedProxy ?? false,
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
        telemetry: options.telemetryEnabled ? ctx.get('ovo.telemetry') : undefined,
        infrastructure: options.infrastructureEnabled
          ? (ctx.get('ovo.infrastructure') as InfrastructureService)
          : undefined,
        secrets,
        auth,
        options: {
          ...options,
          createReleasePlugins:
            options.createReleasePlugins ??
            createDefaultReleaseFactory(store, options.defaultSession),
        },
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
      registerReadinessRoutes(routeDependencies);
      registerInfrastructureRoutes({
        app,
        store,
        requireRole,
        infrastructure: routeDependencies.infrastructure,
      });
      registerOperationsRoutes({
        app,
        store,
        requireRole,
        operations: options.operationsEnabled
          ? (ctx.get('ovo.operations') as OperationsService)
          : undefined,
      });
      registerEvaluationDatasetRoutes({
        app,
        store,
        requireRole,
        fixtureBindingVersion: EVALUATION_FIXTURE_BINDING_VERSION,
        evaluations: options.evaluationsEnabled
          ? (ctx.get('ovo.evaluations') as PostgresEvaluationService)
          : undefined,
      });
      registerPerformanceRoutes({
        app,
        store,
        requireRole,
        performance: options.telemetryEnabled
          ? (ctx.get('ovo.telemetry') as PerformanceService)
          : undefined,
      });
      registerCostRoutes({
        app,
        controlStore: store,
        requireRole,
        audit: (value) => store.audit(value),
        ledger: options.costLedgerEnabled
          ? (ctx.get('ovo.cost-ledger') as CostLedgerService)
          : undefined,
      });

      registerCredentialsRoutes(routeDependencies);

      registerMcpRoutes(routeDependencies);

      registerSimulationRoutes(routeDependencies);

      registerInspectionRoutes(routeDependencies);
      registerRecordingRoutes({
        app,
        store,
        recordings:
          options.fixtureRecordingsEnabled !== false
            ? (ctx.get('ovo.recordings') as RecordingArchive)
            : undefined,
        requireRole,
        error,
      });

      registerRecordingLifecycleRoutes({
        app,
        store,
        requireRole,
        error,
        recordings: options.productionRecordingsEnabled
          ? getProductionRecordingServices(ctx)
          : undefined,
      });
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
