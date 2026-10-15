/** What the distribution passes from `OVO_LIVEKIT_*` (the plugin never reads the environment). */
export interface RoomConfig {
  /** Internal signalling URL the api and workers use: ws(s):// or http(s)://. */
  url: string;
  /** What browsers connect to, returned in grants; defaults to `url`. */
  publicUrl: string;
  apiKey: string;
  apiSecret: string;
  /** The key pair being rotated out; used only when the server rejects the current one. */
  previousApiKey?: string;
  previousApiSecret?: string;
  /** The longest an operator join token may live (30 to 600 s); `mintToken` refuses more. */
  tokenTtlSeconds: number;
}

export const TOKEN_TTL_BOUNDS = Object.freeze({ min: 30, max: 600 });

const SCHEMES = new Set(['ws:', 'wss:', 'http:', 'https:']);
/** LiveKit's own floor: shorter secrets are warned about at server start. */
export const MIN_SECRET_LENGTH = 32;

function urlProblem(name: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return `${name} is required`;
  try {
    const url = new URL(value);
    if (!SCHEMES.has(url.protocol)) return `${name} must be ws, wss, http or https`;
    if (url.username || url.password || url.search || url.hash)
      return `${name} must not carry credentials, a query or a fragment`;
    return undefined;
  } catch {
    return `${name} is not a URL`;
  }
}

const secretProblem = (name: string, value: unknown): string | undefined =>
  typeof value === 'string' && value.length >= MIN_SECRET_LENGTH
    ? undefined
    : `${name} must be at least ${MIN_SECRET_LENGTH} characters`;

/** Throws one readable error naming every problem; never echoes a secret. */
export function parseRoomConfig(raw: Record<string, unknown>): RoomConfig {
  const problems = [
    urlProblem('url', raw.url),
    raw.publicUrl === undefined ? undefined : urlProblem('publicUrl', raw.publicUrl),
    typeof raw.apiKey === 'string' && raw.apiKey ? undefined : 'apiKey is required',
    secretProblem('apiSecret', raw.apiSecret),
    (raw.previousApiKey === undefined) !== (raw.previousApiSecret === undefined)
      ? 'previousApiKey and previousApiSecret go together'
      : undefined,
    raw.previousApiSecret === undefined
      ? undefined
      : secretProblem('previousApiSecret', raw.previousApiSecret),
    raw.tokenTtlSeconds === undefined ||
    (Number.isInteger(raw.tokenTtlSeconds) &&
      (raw.tokenTtlSeconds as number) >= TOKEN_TTL_BOUNDS.min &&
      (raw.tokenTtlSeconds as number) <= TOKEN_TTL_BOUNDS.max)
      ? undefined
      : `tokenTtlSeconds must be an integer from ${TOKEN_TTL_BOUNDS.min} to ${TOKEN_TTL_BOUNDS.max}`,
  ].filter((problem): problem is string => problem !== undefined);
  if (problems.length) throw new TypeError(`Invalid room plugin config: ${problems.join('; ')}`);
  return {
    url: raw.url as string,
    publicUrl: (raw.publicUrl as string | undefined) ?? (raw.url as string),
    apiKey: raw.apiKey as string,
    apiSecret: raw.apiSecret as string,
    tokenTtlSeconds: (raw.tokenTtlSeconds as number | undefined) ?? TOKEN_TTL_BOUNDS.max,
    ...(raw.previousApiKey !== undefined
      ? {
          previousApiKey: raw.previousApiKey as string,
          previousApiSecret: raw.previousApiSecret as string,
        }
      : {}),
  };
}

/** The REST origin for a signalling URL (`wss://x` → `https://x`). */
export function httpOrigin(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
  return parsed.origin;
}

/** The websocket origin for a signalling URL (`http://x` → `ws://x`). */
export function wsOrigin(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  return parsed.origin;
}
