import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  OPERATIONS_SERVICE_KEY,
  PostgresOperationsService,
  createTwilioHandoffProvider,
  normalizePhoneNumber,
  type OperationsService,
  type TwilioHandoffClient,
} from '@winsendotai/ovo-plugin-operations';

export {
  TwilioHandoffProvider,
  type TwilioHandoffClient,
} from '@winsendotai/ovo-plugin-operations';

type Environment = Readonly<Record<string, string | undefined>>;

export interface OperationsRuntimeConfig {
  organizationId: string;
  maxConnections: number;
  operations: Readonly<{
    permittedFromNumbers: readonly string[];
    liveEnabled: boolean;
  }>;
  handoffProvider: 'twilio' | 'unavailable';
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
  twilio?: {
    accountSid: string;
    authToken: string;
    resumeUrl?: string;
    client?: TwilioHandoffClient;
  };
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
  if (!options.twilio && configuredProvider && configuredProvider !== 'twilio')
    throw new Error(`Unsupported OVO_HANDOFF_PROVIDER ${configuredProvider}`);
  const twilioOptions =
    options.twilio ??
    (configuredProvider === 'twilio'
      ? {
          accountSid: required(environment.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID'),
          authToken: required(environment.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN'),
          resumeUrl: environment.OVO_TWILIO_HANDOFF_RESUME_URL,
        }
      : undefined);
  const handoffProvider = twilioOptions
    ? createTwilioHandoffProvider({
        accountSid: required(twilioOptions.accountSid, 'TWILIO_ACCOUNT_SID'),
        authToken: required(twilioOptions.authToken, 'TWILIO_AUTH_TOKEN'),
        resumeUrl: twilioOptions.resumeUrl,
        client: twilioOptions.client,
      })
    : undefined;

  const service = new PostgresOperationsService({
    organizationId,
    connectionString: databaseUrl,
    maxConnections,
    handoffProvider,
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
      handoffProvider: handoffProvider ? 'twilio' : 'unavailable',
    },
    service,
    plugin,
    close,
  };
}
