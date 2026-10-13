import type { SipRequestVerifier } from '@winsendotai/ovo-contracts';
import { bufferOf, decodeBase64, decodeBase64Url, encodeBase64Url, toHex } from './bytes.ts';
import { SIP_HEADERS } from './wire.ts';

/** |now − timestamp| allowed by the verifier (§5.1). */
export const SIP_SIGNATURE_SKEW_MS = 30_000;
export const SIP_NONCE_TTL_MS = 60_000;
export const SIP_MAX_NONCES = 10_000;
/** Decoded key length floor for `OVO_SIP_GATEWAY_SECRET`. */
export const SIP_MIN_KEY_BYTES = 32;

const encoder = new TextEncoder();
type Method = 'GET' | 'POST';

/** Decodes a base64 (or base64url) deployment secret; refuses one shorter than 32 bytes. */
export function decodeSipSecret(value: string): Uint8Array {
  const trimmed = value.trim();
  let key: Uint8Array | undefined;
  try {
    key = decodeBase64(trimmed);
  } catch {
    key = decodeBase64Url(trimmed.replace(/=+$/, ''));
  }
  if (!key) throw new TypeError('The SIP gateway secret is not base64');
  if (key.byteLength < SIP_MIN_KEY_BYTES)
    throw new TypeError(
      `The SIP gateway secret must decode to at least ${SIP_MIN_KEY_BYTES} bytes`,
    );
  return key;
}

/**
 * The URL the media gateway reports as `externalUrl` for a request on `path`: the public origin
 * (with any explicit port), the exact path, never a query. The sip-gateway signs this while it
 * connects to the gateway over loopback.
 */
export function canonicalUrl(publicBaseUrl: string, path: string, scheme: 'https' | 'wss'): string {
  const base = new URL(publicBaseUrl);
  if (base.protocol !== 'https:') throw new TypeError('The public base URL must use https');
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new TypeError('The signed path must be origin-relative');
  return `${scheme}://${base.host}${stripQuery(path)}`;
}

function stripQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end < 0 ? url : url.slice(0, end);
}

/** `v1\nMETHOD\nurl-without-query\ntimestamp\nnonce\nhex(sha256(body))`, no trailing newline. */
async function canonicalString(input: {
  method: Method;
  externalUrl: string;
  timestamp: string;
  nonce: string;
  body: Uint8Array;
}): Promise<Uint8Array<ArrayBuffer>> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bufferOf(input.body)));
  return encoder.encode(
    [
      'v1',
      input.method,
      stripQuery(input.externalUrl),
      input.timestamp,
      input.nonce,
      toHex(digest),
    ].join('\n'),
  );
}

function hmacKey(key: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bufferOf(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    usage,
  ]);
}

/** The four ovo-sip/1 headers for one request. `now` and `nonce` are for tests and vectors. */
export async function signRequest(input: {
  key: Uint8Array;
  method: Method;
  externalUrl: string;
  body: Uint8Array;
  now?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const timestamp = String(Math.trunc(input.now ?? Date.now()));
  const nonce = input.nonce ?? encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const data = await canonicalString({ ...input, timestamp, nonce });
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(input.key, 'sign'), data);
  return {
    [SIP_HEADERS.version]: '1',
    [SIP_HEADERS.timestamp]: timestamp,
    [SIP_HEADERS.nonce]: nonce,
    [SIP_HEADERS.signature]: `v1=${encodeBase64Url(new Uint8Array(signature))}`,
  };
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string) {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/**
 * Verifies ovo-sip/1 signatures with WebCrypto. Accepts any of `keys` (current, then previous, for
 * rotation), a timestamp within ±30 s, and each nonce once within its TTL. A nonce is recorded only
 * after its signature verified, so unauthenticated traffic cannot fill the cache; a cache full of
 * live nonces fails closed.
 */
export function createSipRequestVerifier(input: {
  keys: Uint8Array[];
  now?: () => number;
  nonceTtlMs?: number;
  maxNonces?: number;
  skewMs?: number;
}): SipRequestVerifier {
  if (!input.keys.length) throw new TypeError('The SIP request verifier needs a key');
  const now = input.now ?? Date.now;
  const ttl = input.nonceTtlMs ?? SIP_NONCE_TTL_MS;
  const max = input.maxNonces ?? SIP_MAX_NONCES;
  const skew = input.skewMs ?? SIP_SIGNATURE_SKEW_MS;
  let keys: Promise<CryptoKey[]> | undefined;
  const nonces = new Map<string, number>();
  const prune = (at: number) => {
    for (const [nonce, expires] of nonces) {
      if (expires > at) break;
      nonces.delete(nonce);
    }
  };
  return {
    async verify({ method, externalUrl, headers, body }) {
      if (method !== 'GET' && method !== 'POST') return false;
      if (header(headers, SIP_HEADERS.version) !== '1') return false;
      const timestamp = header(headers, SIP_HEADERS.timestamp) ?? '';
      if (!/^\d{1,16}$/.test(timestamp)) return false;
      const at = now();
      if (Math.abs(at - Number(timestamp)) > skew) return false;
      const nonce = header(headers, SIP_HEADERS.nonce) ?? '';
      if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) return false;
      const match = /^v1=([A-Za-z0-9_-]{43})$/.exec(header(headers, SIP_HEADERS.signature) ?? '');
      const signature = match ? decodeBase64Url(match[1]!) : undefined;
      if (signature?.byteLength !== 32) return false;
      prune(at);
      if (nonces.has(nonce)) return false;
      const data = await canonicalString({ method, externalUrl, timestamp, nonce, body });
      keys ??= Promise.all(input.keys.map((key) => hmacKey(key, 'verify')));
      let verified = false;
      for (const key of await keys)
        if (await crypto.subtle.verify('HMAC', key, bufferOf(signature), data)) {
          verified = true;
          break;
        }
      // Re-checked after the awaits: two concurrent deliveries of one nonce admit only one.
      if (!verified || nonces.has(nonce) || nonces.size >= max) return false;
      nonces.set(nonce, at + ttl);
      return true;
    },
  };
}
