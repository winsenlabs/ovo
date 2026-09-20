import { definePlugin } from '@winsendotai/ovo-runtime';
import { NodeSqliteControlStore } from './sqlite/store.ts';
import type { ControlStore } from './models.ts';

export * from './models.ts';
export { redactAudit } from './sqlite/shared.ts';
export { NodeSqliteControlStore } from './sqlite/store.ts';

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
      properties: { filename: { type: 'string' } },
      additionalProperties: false,
    },
    secretFields: [],
  },
  (ctx, config) => {
    const store = new NodeSqliteControlStore(
      typeof config.filename === 'string' ? config.filename : './data/ovo.sqlite',
    );
    ctx.provide('controlStore', store satisfies ControlStore);
    ctx.provide('ovo.operation-store', store.operationStore);
    ctx.fiber.effect(() => () => store.close(), 'close control store');
  },
);
