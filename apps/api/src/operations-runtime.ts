import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  OPERATIONS_SERVICE_KEY,
  PostgresOperationsService,
  normalizePhoneNumber,
  type OperationsService,
  type HandoffProviderPort,
} from '@winsendotai/ovo-plugin-operations';

type Environment = Readonly<Record<string, string | undefined>>;

export interface OperationsRuntimeConfig {
  organizationId: string;
  maxConnections: number;
  operations: Readonly<{
    permittedFromNumbers: readonly string[];
    liveEnabled: boolean;
  }>;
  handoffProvider: 'carrier' | 'unavailable';
}

export interface OperationsRuntime {
  config: OperationsRuntimeConfig;
  service: PostgresOperationsService;
  plugin: PluginDefinition;
  close(): Promise<void>;
}

export interface CreateOperationsRuntimeOptions {
  /** Must be the one compatibility namespace from the authenticated bootstrap identity. */
  organizationId: string;
  databaseUrl?: string;
  environment?: Environment;
  maxConnections?: number;
  liveEnabled?: boolean;
  permittedFromNumbers?: readonly string[];
  handoffProvider?: HandoffProviderPort;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Missing required operations configuration ${name}`);
  return value.trim();
}

function boundedInteger(value: number | string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20)
    throw new Error('Operations max connections must be an integer between 1 and 20');
  return parsed;
}

function parseNumbers(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(normalizePhoneNumber);
}

export async function createOperationsRuntime(
  options: CreateOperationsRuntimeOptions,
): Promise<OperationsRuntime> {
  const environment = options.environment ?? process.env;
  const organizationId = required(options.organizationId, 'organizationId');
  const databaseUrl = required(
    options.databaseUrl ?? environment.OVO_OPERATIONS_DATABASE_URL ?? environment.DATABASE_URL,
    'OVO_OPERATIONS_DATABASE_URL or DATABASE_URL',
  );
  const maxConnections = boundedInteger(
    options.maxConnections ?? environment.OVO_OPERATIONS_PG_MAX_CONNECTIONS,
    5,
  );
  const operationsConfig = Object.freeze({
    permittedFromNumbers: Object.freeze(
      [
        ...new Set(
          options.permittedFromNumbers
            ? options.permittedFromNumbers.map(normalizePhoneNumber)
            : parseNumbers(environment.OVO_PERMITTED_FROM_NUMBERS),
        ),
      ].sort(),
    ),
    liveEnabled:
      options.liveEnabled === true ||
      (options.liveEnabled === undefined && environment.OVO_LIVE_DIAL_ENABLED === 'true'),
  });

  const configuredProvider = environment.OVO_HANDOFF_PROVIDER?.trim();
  if (configuredProvider && configuredProvider !== 'carrier')
    throw new Error(`Unsupported OVO_HANDOFF_PROVIDER ${configuredProvider}`);

  const service = new PostgresOperationsService({
    organizationId,
    connectionString: databaseUrl,
    maxConnections,
    handoffProvider: options.handoffProvider,
    config: operationsConfig,
  });
  try {
    await service.migrate();
  } catch (error) {
    await service.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = () => (closePromise ??= service.close());
  const plugin = definePlugin(
    {
      id: 'ovo.operations.runtime',
      version: '1.0.0',
      contractVersion: 1,
      scope: 'process',
      provides: [OPERATIONS_SERVICE_KEY],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
      ui: { label: 'Single-organization operations runtime' },
    },
    (ctx) => {
      ctx.provide(OPERATIONS_SERVICE_KEY, service as OperationsService);
      ctx.effect(() => () => close());
    },
  );
  return {
    config: {
      organizationId,
      maxConnections,
      operations: operationsConfig,
      handoffProvider: options.handoffProvider ? 'carrier' : 'unavailable',
    },
    service,
    plugin,
    close,
  };
}
