import { definePlugin } from '@winsendotai/ovo-runtime';
import { BoundedByteCache } from './cache.ts';
import type { ByteCacheLimits } from './types.ts';

export const CACHE_SERVICE_KEY = 'ovo.cache';
export const CACHE_PLUGIN_ID = '@winsendotai/ovo-plugin-cache';

export function createCachePlugin() {
  return definePlugin(
    {
      id: CACHE_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [CACHE_SERVICE_KEY],
      configSchema: {
        type: 'object',
        properties: {
          ttlMs: { type: 'integer', minimum: 1, maximum: 86_400_000 },
          maxEntries: { type: 'integer', minimum: 1, maximum: 100_000 },
          maxBytes: { type: 'integer', minimum: 1, maximum: 1_073_741_824 },
          maxEntryBytes: { type: 'integer', minimum: 1, maximum: 268_435_456 },
          maxPending: { type: 'integer', minimum: 1, maximum: 10_000 },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, config) => {
      const cache = new BoundedByteCache(config as ByteCacheLimits);
      ctx.provide(CACHE_SERVICE_KEY, cache);
      ctx.effect(() => () => cache.clear());
    },
  );
}
