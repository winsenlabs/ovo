import { definePlugin, type Context } from '@winsendotai/ovo-runtime';
import { PostgresOrchestrationStore } from './postgres.ts';
import { EcsDesiredCountWriter, EcsTaskProtection, SqsDurableQueue } from './aws.ts';

function requiredString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing ${key}`);
  return value;
}

export const postgresOrchestrationPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/postgres',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['orchestration.store'],
    configSchema: {
      type: 'object',
      required: ['connectionString'],
      properties: { connectionString: { type: 'string' } },
    },
    secretFields: ['connectionString'],
  },
  async (ctx: Context, config) => {
    const store = new PostgresOrchestrationStore({
      connectionString: requiredString(config, 'connectionString'),
    });
    await store.migrate();
    ctx.provide('orchestration.store', store);
    ctx.effect(() => () => store.close());
  },
);

export const sqsOrchestrationPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/sqs',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['orchestration.queue'],
    configSchema: {
      type: 'object',
      required: ['queueUrl'],
      properties: {
        queueUrl: { type: 'string' },
        region: { type: 'string' },
        endpoint: { type: 'string' },
      },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    const queue = new SqsDurableQueue(requiredString(config, 'queueUrl'), {
      region: requiredString(config, 'region'),
      endpoint: typeof config.endpoint === 'string' ? config.endpoint : undefined,
    });
    ctx.provide('orchestration.queue', queue);
    ctx.effect(() => () => queue.destroy());
  },
);

export const ecsProtectionPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/ecs-protection',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: [],
    provides: ['worker.protection'],
    configSchema: {
      type: 'object',
      required: ['cluster', 'taskArn', 'region'],
      properties: {
        cluster: { type: 'string' },
        taskArn: { type: 'string' },
        region: { type: 'string' },
      },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    ctx.provide(
      'worker.protection',
      new EcsTaskProtection(
        requiredString(config, 'cluster'),
        requiredString(config, 'taskArn'),
        typeof config.expiresInMinutes === 'number' ? config.expiresInMinutes : 10,
        { region: requiredString(config, 'region') },
      ),
    );
  },
);

export const ecsCapacityWriterPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-orchestration/ecs-capacity-writer',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    requires: ['orchestration.store'],
    provides: ['capacity.writer'],
    configSchema: {
      type: 'object',
      required: ['authorityId', 'cluster', 'workerService', 'region'],
      properties: {
        authorityId: { type: 'string' },
        cluster: { type: 'string' },
        workerService: { type: 'string' },
        region: { type: 'string' },
      },
    },
    secretFields: [],
  },
  (ctx: Context, config) => {
    ctx.provide(
      'capacity.writer',
      new EcsDesiredCountWriter(
        requiredString(config, 'authorityId'),
        requiredString(config, 'cluster'),
        { workers: requiredString(config, 'workerService') },
        ctx.get('orchestration.store') as PostgresOrchestrationStore,
        { region: requiredString(config, 'region') },
      ),
    );
  },
);

export const plugins = [postgresOrchestrationPlugin, sqsOrchestrationPlugin];
