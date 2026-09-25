import { createUserDirectoryPlugin, USER_PLUGIN_ID } from './user-plugin.ts';
import { Cap } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { compose, definePlugin, manifestKeys, type Composition } from '@winsendotai/ovo-runtime';
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
import { mergeCatalog } from './release-catalog.ts';

const API_NET_PLUGIN_ID = 'ovo.api.node-net';
const apiNetPlugin = definePlugin(
  {
    id: API_NET_PLUGIN_ID,
    version: '1.0.0',
    contractVersion: 2,
    scope: 'process',
    kind: 'infra',
    requires: [],
    provides: [Cap.net],
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
  },
  (ctx) => {
    const net = createNodeNet();
    ctx.provide(Cap.net, net);
    ctx.effect(() => () => net.close());
  },
);

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
  const distribution =
    options.loadedDistribution ??
    (await loadDistribution({
      role: 'api',
      profile: 'compose',
      env: process.env,
    }));
  const behaviorCatalog = createBehaviorPluginCatalog(),
    installedCatalog = mergeCatalog(
      distribution.catalog,
      behaviorCatalog,
      options.pluginCatalog ?? [],
    ),
    carrierProcess = installedCatalog
      .filter(
        (definition) =>
          definition.manifest.scope === 'process' &&
          manifestKeys(definition.manifest).provides.some(
            (entry) => entry.key === Cap.carrierControl || entry.key === Cap.carrierIngress,
          ),
      )
      .map(
        (definition) =>
          distribution.processRows.find((row) => row.id === definition.manifest.id) ?? {
            id: definition.manifest.id,
          },
      ),
    productionRecordings = options.productionRecordings
      ? createRecordingRuntimePlugin(options.productionRecordings)
      : undefined,
    apiPlugin = createManagementApiPlugin({
      ...options,
      usersEnabled: storageAdapter === 'postgres',
      costLedgerEnabled: storageAdapter === 'postgres',
      telemetryEnabled: storageAdapter === 'postgres',
      evaluationsEnabled: storageAdapter === 'postgres',
      fixtureRecordingsEnabled: storageAdapter === 'sqlite',
      productionRecordingsEnabled: !!productionRecordings,
      operationsEnabled: storageAdapter === 'postgres',
      infrastructureEnabled: storageAdapter === 'postgres',
      pluginCatalog: installedCatalog,
      distributionDefaults: options.distributionDefaults ?? distribution.defaults,
      unavailable: options.unavailable ?? distribution.unavailable,
    }),
    catalog = [
      storagePlugin,
      ...(storageAdapter === 'postgres'
        ? [
            createUserDirectoryPlugin(
              options.controlDatabaseUrl!,
              options.identities[0]!.defaultWorkspaceId,
              options.seedAdmin,
            ),
          ]
        : []),
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
              pluginCatalog: installedCatalog,
            }),
          ]
        : []),
      ...(storageAdapter === 'postgres'
        ? [createEvaluationRuntimePlugin(options.controlDatabaseUrl!, installedCatalog)]
        : []),
      ...(storageAdapter === 'postgres' ? [createCostLedgerPlugin()] : []),
      ...(storageAdapter === 'postgres'
        ? [createTelemetryPlugin(options.controlDatabaseUrl!)]
        : []),
      apiNetPlugin,
      ...installedCatalog,
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
      { id: API_NET_PLUGIN_ID },
      ...carrierProcess,
      ...(storageAdapter === 'postgres' ? [{ id: USER_PLUGIN_ID }] : []),
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
