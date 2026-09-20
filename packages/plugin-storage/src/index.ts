import { definePlugin } from '@winsendotai/ovo-runtime';
import { NodeSqliteControlStore } from './sqlite/store.ts';
import { PostgresControlStore } from './postgres/store.ts';
import type { ControlStore } from './control-store.ts';

export * from './models.ts';
export * from './control-store.ts';
export { redactAudit } from './sqlite/shared.ts';
export { NodeSqliteControlStore } from './sqlite/store.ts';
export { PostgresControlStore } from './postgres/store.ts';
export { runControlMigrations } from './postgres/migrations.ts';

export const storagePlugin = definePlugin(
  {
    id: '@winsendotai/ovo-plugin-storage',
    version: '0.1.0',
    contractVersion: 1,
    scope: 'process',
    provides: ['controlStore', 'ovo.operation-store'],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        adapter: { type: 'string', enum: ['sqlite', 'postgres'] },
        filename: { type: 'string' },
        databaseUrl: { type: 'string' },
        maxConnections: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    secretFields: ['databaseUrl'],
  },
  async (ctx, config) => {
    const adapter = config.adapter === 'postgres' ? 'postgres' : 'sqlite';
    if (adapter === 'postgres' && typeof config.databaseUrl !== 'string')
      throw new Error('PostgreSQL storage requires databaseUrl');
    const store: ControlStore =
      adapter === 'postgres'
        ? await PostgresControlStore.open({
            connectionString: config.databaseUrl as string,
            max:
              typeof config.maxConnections === 'number'
                ? Math.trunc(config.maxConnections)
                : undefined,
          })
        : new NodeSqliteControlStore(
            typeof config.filename === 'string' ? config.filename : './data/ovo.sqlite',
          );
    ctx.provide('controlStore', store satisfies ControlStore);
    ctx.provide('ovo.operation-store', store.operationStore);
    ctx.fiber.effect(() => () => store.close(), 'close control store');
  },
);
