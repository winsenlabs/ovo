import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { parseRoomConfig } from './config.ts';
import { LiveKitRoomProvider } from './provider.ts';

export const ROOM_LIVEKIT_PLUGIN_ID = '@winsendotai/ovo-plugin-room-livekit';

/**
 * Capability `ovo.media-room` over a self-hosted LiveKit server (Apache-2.0). Process scope,
 * composed by the api (rooms, operator tokens) and the worker (the caller's seat) only when the
 * room feature is enabled; with it off the capability is absent and managed queues refuse.
 * The keys are plain config here (the distribution reads `OVO_LIVEKIT_*`), never part of a release.
 */
export const roomLivekitPlugin = definePlugin(
  {
    id: ROOM_LIVEKIT_PLUGIN_ID,
    version: '0.1.0',
    contractVersion: 2,
    kind: 'infra',
    provider: 'livekit',
    scope: 'process',
    provides: [Cap.mediaRoom],
    requires: [],
    optional: [],
    configSchema: {
      type: 'object',
      required: ['url', 'apiKey', 'apiSecret'],
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Internal signalling URL (ws, wss, http or https).' },
        publicUrl: { type: 'string', description: 'What browsers connect to; defaults to url.' },
        apiKey: { type: 'string', minLength: 1 },
        apiSecret: { type: 'string', minLength: 32 },
        previousApiKey: { type: 'string', minLength: 1 },
        previousApiSecret: { type: 'string', minLength: 32 },
        tokenTtlSeconds: {
          type: 'integer',
          minimum: 30,
          maximum: 600,
          description: 'Ceiling for operator join tokens; absent means 600.',
        },
      },
    },
    secretFields: [],
    // The room server is an operator-configured private address reached by the LiveKit libraries
    // themselves, so there is no public host for ctx.net to allow. @livekit/rtc-node is a native
    // binding (linux glibc in the images, darwin-arm64 for development), and like the LiveKit
    // engine plugin it is not marked `native: 'glibc'`, so a developer machine can still run it.
    runtime: { egressHosts: [] },
  } as const,
  (ctx, config) => {
    ctx.provide(
      Cap.mediaRoom,
      new LiveKitRoomProvider(parseRoomConfig(config), { logger: ctx.logger }),
    );
  },
);

export const plugins = [roomLivekitPlugin];
