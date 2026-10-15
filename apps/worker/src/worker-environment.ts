import { OPERATIONS_SERVICE_KEY, type OperationsService } from '@winsendotai/ovo-plugin-operations';
import {
  postgresOrchestrationPlugin,
  sqsOrchestrationPlugin,
  type TaskProtection,
} from '@winsendotai/ovo-plugin-orchestration';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import type { Context, PluginDefinition } from '@winsendotai/ovo-runtime';
import { WorkerTelemetryRuntime } from './telemetry-runtime.ts';
import { ROUTING_PREPARE_TIMEOUT_MS } from './segment-prepare.ts';

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

/**
 * Wave 16 (R2) in-call agent transfer: `OVO_ROUTING_TRANSFER_ENABLED` (only the exact value
 * `true`; off by default) gives routed calls `begin`, the hold, `ovo.agent-transfer` and per-segment
 * telemetry and cost tags. Off, a routed call is composed exactly as in Wave 15.
 */
export function transferWorkerOptions(): { transferEnabled: boolean } {
  return { transferEnabled: process.env.OVO_ROUTING_TRANSFER_ENABLED === 'true' };
}

/**
 * Wave 15 routing in the worker (both off or default unless set): `OVO_ROUTING_EXTERNAL_ENABLED`
 * lets the external decision engine call out (only the exact value `true`), and
 * `OVO_ROUTING_PREPARE_TIMEOUT_MS` (500-10000, default 2500) bounds composing the chosen agent.
 */
export function routingWorkerOptions(): { externalEnabled: boolean; prepareTimeoutMs: number } {
  return {
    externalEnabled: process.env.OVO_ROUTING_EXTERNAL_ENABLED === 'true',
    prepareTimeoutMs:
      optionalInteger('OVO_ROUTING_PREPARE_TIMEOUT_MS', 500, 10_000) ?? ROUTING_PREPARE_TIMEOUT_MS,
  };
}
