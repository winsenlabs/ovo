import type { SipTrunkControlClient } from '@winsendotai/ovo-contracts';

type Fetch = (url: string, init: RequestInit & { signal?: AbortSignal }) => Promise<Response>;

/** Builds the request URL; only `/v1/…` paths, so a caller cannot steer the client elsewhere. */
export function controlUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  if (!/^\/v1\/[a-z/]*$/.test(path)) throw new TypeError(`Invalid sip-gateway path ${path}`);
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.href;
}

/** JSON in and out; an empty or non-JSON body becomes `null` and the status decides. */
export async function controlRequest(
  fetcher: Fetch,
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<{ status: number; body: unknown }> {
  const response = await fetcher(url, {
    method: init.method,
    headers: {
      ...init.headers,
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * The worker host's `Cap.sipTrunkControl`: a bearer-authenticated JSON client for the sip-gateway
 * control API on the compose bridge. Plain http is intended; the API never leaves the host.
 */
export function createSipTrunkHttpClient(input: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SipTrunkControlClient {
  const base = new URL(input.baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:')
    throw new TypeError('The sip-gateway control URL must be http or https');
  if (!input.token) throw new TypeError('The sip-gateway control token is empty');
  const fetcher: Fetch = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? 5000;
  return {
    request({ method, path, query, body, signal }) {
      const timeout = AbortSignal.timeout(timeoutMs);
      return controlRequest(fetcher, controlUrl(base.href, path, query), {
        method,
        headers: { authorization: `Bearer ${input.token}` },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    },
  };
}
