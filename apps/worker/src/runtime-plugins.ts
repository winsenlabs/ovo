import {
  type PostgresOrchestrationStore,
  type ReadinessProbe,
  type TaskProtection,
} from '@winsendotai/ovo-plugin-orchestration';
import { definePlugin, type Context } from '@winsendotai/ovo-runtime';

export const localProtectionPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-worker/local-process-protection',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['worker.protection'],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx: Context) => {
    let active = false;
    const service: TaskProtection = {
      async establish() {
        active = true;
        return true;
      },
      async renew() {
        return active;
      },
      async release() {
        active = false;
      },
    };
    ctx.provide('worker.protection', service);
  },
);

export const readinessPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-worker/readiness',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: ['orchestration.store'],
    provides: ['worker.readiness'],
    configSchema: {
      type: 'object',
      required: ['mediaReadinessUrl'],
      properties: { mediaReadinessUrl: { type: 'string' } },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    const store = ctx.get('orchestration.store') as PostgresOrchestrationStore;
    const url = typeof config.mediaReadinessUrl === 'string' ? config.mediaReadinessUrl : '';
    const readiness: ReadinessProbe = {
      async check() {
        try {
          await store.ping();
          if (process.env.OVO_TRANSPORT_CERTIFIED !== 'true')
            return { ready: false as const, reason: 'transport-not-certified' };
          if (!url) return { ready: false as const, reason: 'media-session-handler-not-composed' };
          const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
          if (!response.ok)
            return { ready: false as const, reason: `media-readiness-${response.status}` };
          return { ready: true as const };
        } catch (error) {
          return {
            ready: false as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
    ctx.provide('worker.readiness', readiness);
  },
);

export async function ecsRuntimeConfig(): Promise<{
  protection: Record<string, unknown>;
  workerEndpoint: string;
}> {
  const metadataUri = requiredEnv('ECS_CONTAINER_METADATA_URI_V4');
  const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`ECS task metadata failed: ${response.status}`);
  const metadata = (await response.json()) as {
    Cluster?: unknown;
    TaskARN?: unknown;
    Containers?: Array<{ Networks?: Array<{ IPv4Addresses?: unknown }> }>;
  };
  if (typeof metadata.Cluster !== 'string' || typeof metadata.TaskARN !== 'string')
    throw new Error('ECS task metadata lacks cluster/task ARN');
  process.env.OVO_WORKER_ID ??= metadata.TaskARN;
  const addresses = metadata.Containers?.flatMap((container) =>
    container.Networks?.flatMap((network) =>
      Array.isArray(network.IPv4Addresses)
        ? network.IPv4Addresses.filter((value): value is string => typeof value === 'string')
        : [],
    ),
  );
  const address = addresses?.[0];
  if (!address) throw new Error('ECS task metadata lacks a private IPv4 address');
  return {
    protection: {
      cluster: metadata.Cluster,
      taskArn: metadata.TaskARN,
      region: requiredEnv('AWS_REGION'),
      expiresInMinutes: 10,
    },
    workerEndpoint: `ws://${address}:4100/internal/media`,
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
