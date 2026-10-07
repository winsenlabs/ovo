import { Cap } from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { optionalInteger } from './worker-environment.ts';

/** The worker's `ovo.net`: provider HTTP for live calls and for pre-rendering speech. */
const netManifest = {
  id: 'ovo.worker.node-net',
  version: '1.0.0',
  contractVersion: 2,
  scope: 'process',
  kind: 'host',
  provides: [Cap.net],
  requires: [],
  secretFields: [],
  configSchema: { type: 'object', additionalProperties: false },
} as const;
export const netPlugin = definePlugin(netManifest, (ctx) => {
  // LAT-8: pooled provider connections outlive the gap between caller turns.
  const port = createNodeNet({
    keepAlive: {
      keepAliveTimeoutMs: optionalInteger('OVO_NET_KEEP_ALIVE_MS', 1_000, 600_000),
      keepAliveMaxTimeoutMs: optionalInteger('OVO_NET_KEEP_ALIVE_MAX_MS', 1_000, 3_600_000),
    },
  });
  ctx.effect(() => () => port.close());
  ctx.provide(Cap.net, port);
});
