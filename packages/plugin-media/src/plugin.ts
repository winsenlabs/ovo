import { definePlugin } from '@winsendotai/ovo-runtime';
import { MediaGateway } from './gateway.ts';
import type { MediaGatewayConfig } from './gateway-types.ts';
import type { MediaRouteResolver } from './ports.ts';
import type { MediaDuplex } from './ports.ts';
import { MEDIA_SERVICE_KEYS } from './ports.ts';

export const MEDIA_DUPLEX_SERVICE_KEY = 'ovo.media.duplex';
export const MEDIA_PLUGIN_IDS = Object.freeze({
  routeResolver: '@winsendotai/ovo-plugin-media-route-resolver',
  duplex: '@winsendotai/ovo-plugin-media-duplex',
  gateway: '@winsendotai/ovo-plugin-media-gateway',
});

export function createMediaRouteResolverPlugin(resolver: MediaRouteResolver) {
  return definePlugin(
    {
      id: MEDIA_PLUGIN_IDS.routeResolver,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [MEDIA_SERVICE_KEYS.routeResolver],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(MEDIA_SERVICE_KEYS.routeResolver, resolver);
    },
  );
}

export function createMediaDuplexPlugin(media: MediaDuplex) {
  return definePlugin(
    {
      id: MEDIA_PLUGIN_IDS.duplex,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [MEDIA_DUPLEX_SERVICE_KEY],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(MEDIA_DUPLEX_SERVICE_KEY, media);
      ctx.effect(() => () => media.close('media plugin disposed'));
    },
  );
}

export function createMediaGatewayPlugin(
  secrets: {
    twilioAuthToken: string;
    workerToken: string;
  },
  dependencies: Pick<MediaGatewayConfig, 'httpHandler'> = {},
) {
  return definePlugin(
    {
      id: MEDIA_PLUGIN_IDS.gateway,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [MEDIA_SERVICE_KEYS.routeResolver],
      provides: [MEDIA_SERVICE_KEYS.gateway],
      configSchema: {
        type: 'object',
        required: ['publicBaseUrl'],
        properties: {
          publicBaseUrl: { type: 'string', pattern: '^https://' },
          host: { type: 'string', minLength: 1 },
          port: { type: 'integer', minimum: 1, maximum: 65535 },
          maxMessageBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
          maxAudioFrameBytes: { type: 'integer', minimum: 160, maximum: 65536 },
          maxBufferedBytes: { type: 'integer', minimum: 1024, maximum: 16777216 },
          maxPendingFrames: { type: 'integer', minimum: 1, maximum: 1000 },
          handshakeTimeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          idleTimeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 },
          drainTimeoutMs: { type: 'integer', minimum: 100, maximum: 3600000 },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    async (ctx, config) => {
      const resolver = ctx.get(MEDIA_SERVICE_KEYS.routeResolver) as MediaRouteResolver | undefined;
      if (!resolver) throw new Error(`Missing ${MEDIA_SERVICE_KEYS.routeResolver}`);
      const gateway = new MediaGateway(resolver, {
        publicBaseUrl: String(config.publicBaseUrl),
        twilioAuthToken: secrets.twilioAuthToken,
        workerToken: secrets.workerToken,
        host: typeof config.host === 'string' ? config.host : undefined,
        port: typeof config.port === 'number' ? config.port : undefined,
        maxMessageBytes:
          typeof config.maxMessageBytes === 'number' ? config.maxMessageBytes : undefined,
        maxAudioFrameBytes:
          typeof config.maxAudioFrameBytes === 'number' ? config.maxAudioFrameBytes : undefined,
        maxBufferedBytes:
          typeof config.maxBufferedBytes === 'number' ? config.maxBufferedBytes : undefined,
        maxPendingFrames:
          typeof config.maxPendingFrames === 'number' ? config.maxPendingFrames : undefined,
        handshakeTimeoutMs:
          typeof config.handshakeTimeoutMs === 'number' ? config.handshakeTimeoutMs : undefined,
        idleTimeoutMs: typeof config.idleTimeoutMs === 'number' ? config.idleTimeoutMs : undefined,
        drainTimeoutMs:
          typeof config.drainTimeoutMs === 'number' ? config.drainTimeoutMs : undefined,
        httpHandler: dependencies.httpHandler,
      });
      await gateway.listen();
      ctx.provide(MEDIA_SERVICE_KEYS.gateway, gateway);
      ctx.effect(() => () => gateway.drain());
    },
  );
}
