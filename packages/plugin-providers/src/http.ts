import { isIP } from 'node:net';
import { isPublicAddress } from '@winsendotai/ovo-plugin-tools-http';
import { ProviderProtocolError } from './types.ts';

export interface ProviderHttpDependencies {
  fetch?: typeof globalThis.fetch;
  /** Local TLS protocol tests only; never expose through plugin configuration. */
  allowPrivateTestEndpoint?: boolean;
}

export function validateProviderEndpoint(
  endpoint: string,
  expectedPath: string,
  allowPrivateTestEndpoint = false,
  expectedHostname = 'api.openai.com',
): URL {
  const url = new URL(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') throw new TypeError('Provider endpoints must use HTTPS');
  if (url.username || url.password || url.search || url.hash)
    throw new TypeError('Provider endpoints cannot contain credentials, query, or fragments');
  if (url.pathname !== expectedPath)
    throw new TypeError(`Provider endpoint must end at ${expectedPath}`);
  if (
    !allowPrivateTestEndpoint &&
    (hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      (isIP(hostname) && !isPublicAddress(hostname)))
  ) {
    throw new TypeError('Private provider endpoints are forbidden');
  }
  if (!allowPrivateTestEndpoint && hostname !== expectedHostname)
    throw new TypeError(`Provider endpoint must use ${expectedHostname}`);
  return url;
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProviderProtocolError('Provider response has no body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderProtocolError('Provider response exceeded the configured byte limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ProviderProtocolError('Provider returned malformed JSON');
  }
}

export async function assertSuccessful(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  throw new ProviderProtocolError(`Provider request failed with HTTP ${response.status}`);
}
