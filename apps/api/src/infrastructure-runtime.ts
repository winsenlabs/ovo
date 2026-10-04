import { Pool } from 'pg';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { PostgresInfrastructureService } from './infrastructure-service.ts';
import type { InfrastructureService } from './infrastructure-types.ts';

export const INFRASTRUCTURE_SERVICE_KEY = 'ovo.infrastructure';

type Environment = Readonly<Record<string, string | undefined>>;

export interface InfrastructureRuntimeConfig {
  organizationId: string;
  databaseUrl?: string;
  environment?: Environment;
  installationEnabled?: boolean;
  capacityCeiling?: number | null;
  maxConnections?: number;
  heartbeatMaxAgeMs?: number;
}

export interface InfrastructureRuntime {
  service: InfrastructureService;
  plugin: PluginDefinition;
  close(): Promise<void>;
}

export async function createInfrastructureRuntime(
  config: InfrastructureRuntimeConfig,
): Promise<InfrastructureRuntime> {
  const validated = validateConfig(config);
  const pool = new Pool({
    connectionString: validated.databaseUrl,
    max: validated.maxConnections,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw error;
  }
  const service = new PostgresInfrastructureService(pool, validated);
  let closePromise: Promise<void> | undefined;
  const close = () => (closePromise ??= pool.end());
  const plugin = definePlugin(
    {
      id: 'ovo.infrastructure.runtime',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      provides: [INFRASTRUCTURE_SERVICE_KEY],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      ui: { label: 'Read-only infrastructure snapshot' },
    },
    (ctx) => {
      ctx.provide(INFRASTRUCTURE_SERVICE_KEY, service);
      ctx.effect(() => () => close());
    },
  );
  return { service, plugin, close };
}

function validateConfig(config: InfrastructureRuntimeConfig) {
  const environment = config.environment ?? process.env;
  const capacity =
    config.capacityCeiling === undefined
      ? optionalInteger(environment.OVO_WORKER_MAX_CAPACITY, 0, 100_000, 'OVO_WORKER_MAX_CAPACITY')
      : optionalInteger(config.capacityCeiling, 0, 100_000, 'capacityCeiling');
  return {
    organizationId: required(config.organizationId, 'organizationId'),
    databaseUrl: required(
      config.databaseUrl ?? environment.OVO_ORCHESTRATION_DATABASE_URL ?? environment.DATABASE_URL,
      'OVO_ORCHESTRATION_DATABASE_URL or DATABASE_URL',
    ),
    installationEnabled: config.installationEnabled ?? environment.OVO_LIVE_DIAL_ENABLED === 'true',
    capacityCeiling: capacity,
    maxConnections: integer(
      config.maxConnections ?? environment.OVO_INFRASTRUCTURE_PG_MAX_CONNECTIONS ?? 2,
      1,
      2,
      'maxConnections',
    ),
    heartbeatMaxAgeMs: integer(
      config.heartbeatMaxAgeMs ?? environment.OVO_CAPACITY_MAX_AGE_MS ?? 15_000,
      1_000,
      60_000,
      'heartbeatMaxAgeMs',
    ),
  };
}

function required(value: string | undefined, name: string) {
  if (!value?.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

function optionalInteger(
  value: number | string | null | undefined,
  min: number,
  max: number,
  name: string,
) {
  if (value === null || value === undefined || value === '') return null;
  return integer(value, min, max, name);
}

function integer(value: number | string, min: number, max: number, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}
