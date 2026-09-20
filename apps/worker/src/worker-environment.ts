import {
  createTwilioHandoffProvider,
  OPERATIONS_SERVICE_KEY,
  type HandoffProviderPort,
  type OperationsService,
} from '@winsendotai/ovo-plugin-operations';
import {
  postgresOrchestrationPlugin,
  sqsOrchestrationPlugin,
  type TaskProtection,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { Context, PluginDefinition } from '@winsendotai/ovo-runtime';
import { WorkerTelemetryRuntime } from './telemetry-runtime.ts';

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function optionalInteger(
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return parsed;
}

export function durableAdapterPlugins(): {
  definitions: PluginDefinition[];
  rows: Array<{ id: string; config: Record<string, unknown> }>;
} {
  return {
    definitions: [postgresOrchestrationPlugin, sqsOrchestrationPlugin],
    rows: [
      {
        id: postgresOrchestrationPlugin.manifest.id,
        config: { connectionString: env('DATABASE_URL') },
      },
      {
        id: sqsOrchestrationPlugin.manifest.id,
        config: {
          queueUrl: env('OVO_QUEUE_URL'),
          region: env('AWS_REGION'),
          endpoint: process.env.OVO_SQS_ENDPOINT || undefined,
        },
      },
    ],
  };
}

export function workerHandoffProvider(): HandoffProviderPort | undefined {
  const provider = process.env.OVO_HANDOFF_PROVIDER?.trim();
  if (!provider) return undefined;
  if (provider !== 'twilio') throw new Error(`Unsupported OVO_HANDOFF_PROVIDER ${provider}`);
  return createTwilioHandoffProvider({
    accountSid: env('TWILIO_ACCOUNT_SID'),
    authToken: env('TWILIO_AUTH_TOKEN'),
    resumeUrl: process.env.OVO_TWILIO_HANDOFF_RESUME_URL,
  });
}

export function workerRuntimeServices(ctx: Context): {
  protection: TaskProtection;
  operations: OperationsService;
} {
  return {
    protection: ctx.get('worker.protection') as TaskProtection,
    operations: ctx.get(OPERATIONS_SERVICE_KEY) as OperationsService,
  };
}

export function openWorkerTelemetry(databaseUrl: string, controlStore: ControlStore) {
  return WorkerTelemetryRuntime.open({
    databaseUrl,
    controlStore,
    maxConnections: optionalInteger('OVO_TELEMETRY_PG_MAX_CONNECTIONS', 1, 10),
    retentionDays: optionalInteger('OVO_TELEMETRY_RETENTION_DAYS', 1, 365),
    maxQueuedEvents: optionalInteger('OVO_TELEMETRY_MAX_QUEUED_EVENTS', 1, 100_000),
    maxCallEvents: optionalInteger('OVO_CALL_EVENT_MAX_QUEUED_EVENTS', 1, 100_000),
    onError: (error) => console.error('worker telemetry error:', error.message),
  });
}
