import type { PluginRow } from '@winsendotai/ovo-runtime';
import type { Environment } from './types.ts';

/** The room plugin's package name and manifest id (the media lane's plugin must declare it). */
export const ROOM_PLUGIN_ID = '@winsendotai/ovo-plugin-room-livekit';
/** Where the api and workers reach the room server over the compose bridge (host-network server). */
export const DEFAULT_ROOM_URL = 'ws://172.29.240.1:7880';
export const DEFAULT_ROOM_TOKEN_TTL_SECONDS = 120;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function webSocketUrl(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if (!/^wss?:\/\/[^\s/]+(?:[/:][^\s]*)?$/.test(value))
    throw new Error(`${name} must be a ws:// or wss:// URL`);
  return value;
}

/**
 * The self-hosted room server (managed human queues). Composed only when `OVO_LIVEKIT_ENABLED` is
 * exactly `true`: otherwise there is no row, the catalog entry is left out, and `ovo.media-room` is
 * never provided. The server's API key pair is a secret and never leaves the process config.
 */
export function roomRows(env: Environment): PluginRow[] {
  if (env.OVO_LIVEKIT_ENABLED !== 'true') return [];
  // Compose renders an unset optional variable as an empty string, which means "the default".
  const configuredTtl = env.OVO_LIVEKIT_TOKEN_TTL_SECONDS?.trim();
  const ttl = configuredTtl ? Number(configuredTtl) : DEFAULT_ROOM_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 30 || ttl > 600)
    throw new Error('OVO_LIVEKIT_TOKEN_TTL_SECONDS must be an integer from 30 to 600');
  const previousKey = env.OVO_LIVEKIT_API_KEY_PREVIOUS?.trim();
  const previousSecret = env.OVO_LIVEKIT_API_SECRET_PREVIOUS?.trim();
  if (Boolean(previousKey) !== Boolean(previousSecret))
    throw new Error('OVO_LIVEKIT_API_KEY_PREVIOUS and OVO_LIVEKIT_API_SECRET_PREVIOUS go together');
  const publicUrl = webSocketUrl(env, 'OVO_LIVEKIT_PUBLIC_URL');
  return [
    {
      id: ROOM_PLUGIN_ID,
      config: {
        url: webSocketUrl(env, 'OVO_LIVEKIT_URL') ?? DEFAULT_ROOM_URL,
        ...(publicUrl ? { publicUrl } : {}),
        apiKey: required(env, 'OVO_LIVEKIT_API_KEY'),
        apiSecret: required(env, 'OVO_LIVEKIT_API_SECRET'),
        ...(previousKey && previousSecret
          ? { previousApiKey: previousKey, previousApiSecret: previousSecret }
          : {}),
        tokenTtlSeconds: ttl,
      },
    },
  ];
}
