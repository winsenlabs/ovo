import { canonicalUrl, signRequest } from '@winsendotai/ovo-sip-carrier-kit';

/** How the sip-gateway reaches the media gateway: loopback origin, public signing origin. */
export interface BridgeTarget {
  /** `OVO_SIP_MEDIA_INTERNAL_URL`, e.g. http://127.0.0.1:4001. */
  internalUrl: string;
  /** `OVO_MEDIA_PUBLIC_BASE_URL`: what the gateway rebuilds `externalUrl` from. */
  publicBaseUrl: string;
  key: Uint8Array;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The path and query of a URL the host handed out (a grant's statusUrl, a dial callback, a wait
 * retryUrl). Only `/carriers/…` paths are followed, so a decision can never point us elsewhere.
 */
export function carrierPath(url: string): string {
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith('/carriers/')) throw new TypeError('Not a carrier callback URL');
  return `${parsed.pathname}${parsed.search}`;
}

export class BridgeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeHttpError';
  }
}

/** POSTs signed JSON to `pathAndQuery` on the media gateway; resolves the parsed reply. */
export async function signedPost(
  target: BridgeTarget,
  pathAndQuery: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const path = pathAndQuery.split('?', 1)[0]!;
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const headers = await signRequest({
    key: target.key,
    method: 'POST',
    externalUrl: canonicalUrl(target.publicBaseUrl, path, 'https'),
    body: bytes,
  });
  const response = await (target.fetch ?? fetch)(new URL(pathAndQuery, target.internalUrl), {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: bytes,
    signal: AbortSignal.timeout(target.timeoutMs ?? 5_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

/** Retries a POST on transport errors and 5xx (fresh signature and nonce each time). */
export async function signedPostWithRetry(
  target: BridgeTarget,
  pathAndQuery: string,
  body: unknown,
  attempts = 3,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ status: number; json: unknown }> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const reply = await signedPost(target, pathAndQuery, body);
      if (reply.status < 500) return reply;
      last = new BridgeHttpError(reply.status, `media gateway HTTP ${reply.status}`);
    } catch (error) {
      last = error;
    }
    if (attempt + 1 < attempts) await sleep(250 * 2 ** attempt);
  }
  throw last;
}
