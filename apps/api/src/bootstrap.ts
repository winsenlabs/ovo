import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { compose, type Composition } from '@winsendotai/ovo-runtime';
import { createBehaviorPluginCatalog } from '@winsendotai/ovo-behaviors';
import { storagePlugin } from '@winsendotai/ovo-plugin-storage';
import { secretsPlugin } from '@winsendotai/ovo-plugin-secrets';
import {
  observabilityPlugin,
  createTelemetryPlugin,
  TELEMETRY_PLUGIN_ID,
} from '@winsendotai/ovo-plugin-observability';
import { recordingsPlugin } from '@winsendotai/ovo-plugin-recordings';
import { createCostLedgerPlugin } from '@winsendotai/ovo-plugin-ledger';
import { createManagementApiPlugin } from './api-plugin.ts';
import { createRecordingRuntimePlugin } from './recording-runtime.ts';
import {
  createInfrastructureRuntimePlugin,
  INFRASTRUCTURE_RUNTIME_PLUGIN_ID,
} from './infrastructure-plugin.ts';
import {
  createOperationsRuntimePlugin,
  OPERATIONS_RUNTIME_PLUGIN_ID,
} from './operations-plugin.ts';
import {
  createEvaluationRuntimePlugin,
  EVALUATION_RUNTIME_PLUGIN_ID,
} from './evaluation-plugin.ts';
import type { BuildApiOptions, ManagementApiService } from './types.ts';

export async function buildManagementApi(
  options: BuildApiOptions,
): Promise<{ app: FastifyInstance; composition: Composition }> {
  if (!options.identities.length) throw new Error('At least one bootstrap identity is required');
  const storageAdapter = options.storageAdapter ?? 'sqlite';
  if (process.env.NODE_ENV === 'production' && storageAdapter !== 'postgres')
    throw new Error('Production management API requires shared PostgreSQL storage');
  if (storageAdapter === 'postgres' && !options.controlDatabaseUrl)
    throw new Error('PostgreSQL storage requires controlDatabaseUrl');
  if (storageAdapter === 'postgres' && (options.secretBackend ?? 'local') === 'local')
    throw new Error('PostgreSQL storage requires encrypted-store or aws-secrets-manager secrets');
  if (storageAdapter === 'sqlite' && options.secretBackend === 'encrypted-store')
    throw new Error('encrypted-store secrets require PostgreSQL storage');
  const behaviorCatalog = createBehaviorPluginCatalog(),
    productionRecordings = options.productionRecordings
      ? createRecordingRuntimePlugin(options.productionRecordings)
      : undefined,
    apiPlugin = createManagementApiPlugin({
      ...options,
      costLedgerEnabled: storageAdapter === 'postgres',
      telemetryEnabled: storageAdapter === 'postgres',
      evaluationsEnabled: storageAdapter === 'postgres',
      fixtureRecordingsEnabled: storageAdapter === 'sqlite',
      productionRecordingsEnabled: !!productionRecordings,
      operationsEnabled: storageAdapter === 'postgres',
      infrastructureEnabled: storageAdapter === 'postgres',
      pluginCatalog: [...behaviorCatalog, ...(options.pluginCatalog ?? [])],
    }),
    catalog = [
      storagePlugin,
      secretsPlugin,
      observabilityPlugin,
      recordingsPlugin,
      ...(productionRecordings ? [productionRecordings] : []),
      ...(storageAdapter === 'postgres'
        ? [
            createInfrastructureRuntimePlugin({
              databaseUrl: options.controlDatabaseUrl,
              organizationId: options.identities[0]!.defaultWorkspaceId,
              installationEnabled: options.operations?.liveEnabled,
              environment: options.operations?.environment,
            }),
          ]
        : []),
      ...(storageAdapter === 'postgres'
        ? [
            createOperationsRuntimePlugin({
              ...options.operations,
              databaseUrl: options.controlDatabaseUrl,
              organizationId: options.identities[0]!.defaultWorkspaceId,
            }),
          ]
        : []),
      ...(storageAdapter === 'postgres'
        ? [createEvaluationRuntimePlugin(options.controlDatabaseUrl!)]
        : []),
      ...(storageAdapter === 'postgres' ? [createCostLedgerPlugin()] : []),
      ...(storageAdapter === 'postgres'
        ? [createTelemetryPlugin(options.controlDatabaseUrl!)]
        : []),
      ...behaviorCatalog,
      ...(options.pluginCatalog ?? []),
      apiPlugin,
    ];
  const composition = await compose(
    [
      {
        id: storagePlugin.manifest.id,
        config:
          storageAdapter === 'postgres'
            ? {
                adapter: 'postgres',
                databaseUrl: options.controlDatabaseUrl,
                ...(options.storageMaxConnections === undefined
                  ? {}
                  : { maxConnections: options.storageMaxConnections }),
              }
            : {
                adapter: 'sqlite',
                filename: options.databaseFile ?? './data/ovo.sqlite',
              },
      },
      {
        id: secretsPlugin.manifest.id,
        config: {
          backend: options.secretBackend ?? 'local',
          masterKey: options.secretsMasterKey,
          region: options.awsRegion,
        },
      },
      { id: observabilityPlugin.manifest.id },
      ...(storageAdapter === 'sqlite'
        ? [
            {
              id: recordingsPlugin.manifest.id,
              config: {
                backend: 'local',
                directory:
                  options.recordingDirectory ??
                  join(dirname(options.databaseFile ?? './data/ovo.sqlite'), '.recordings'),
              },
            },
          ]
        : []),
      ...(productionRecordings ? [{ id: productionRecordings.manifest.id }] : []),
      { id: apiPlugin.manifest.id },
      ...(storageAdapter === 'postgres' ? [{ id: INFRASTRUCTURE_RUNTIME_PLUGIN_ID }] : []),
      ...(storageAdapter === 'postgres' ? [{ id: OPERATIONS_RUNTIME_PLUGIN_ID }] : []),
      ...(storageAdapter === 'postgres' ? [{ id: EVALUATION_RUNTIME_PLUGIN_ID }] : []),
      ...(storageAdapter === 'postgres' ? [{ id: TELEMETRY_PLUGIN_ID }] : []),
      ...(storageAdapter === 'postgres'
        ? [
            {
              id: '@winsendotai/ovo-plugin-ledger',
              config: { databaseUrl: options.controlDatabaseUrl },
            },
          ]
        : []),
    ],
    catalog,
  );
  const service = composition.ctx.get('managementApi') as ManagementApiService;
  return { app: service.app, composition };
}
