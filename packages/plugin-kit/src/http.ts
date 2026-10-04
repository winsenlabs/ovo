import type { NetPort } from '@winsendotai/ovo-contracts';
import { abortError, withDeadline } from './abort.ts';
import { isIpLiteral, isPublicAddress } from './ssrf.ts';

export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}

/**
 * The endpoint a provider plugin may call: https, no credentials, exactly `expectedPath` on
 * exactly `expectedHostname`. The hostname is required — a shared kit has no default vendor, and
 * one baked in here would hand a plugin that forgot the argument another vendor's error message.
 */
export function validateProviderEndpoint(
  endpoint: string,
  expectedPath: string,
  expectedHostname: string,
  allowPrivateTestEndpoint = false,
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
      (isIpLiteral(hostname) && !isPublicAddress(hostname)))
  ) {
    throw new TypeError('Private provider endpoints are forbidden');
  }
  if (!allowPrivateTestEndpoint && hostname !== expectedHostname)
    throw new TypeError(`Provider endpoint must use ${expectedHostname}`);
  return url;
}

export async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
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
  return bytes;
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new ProviderProtocolError('Provider response has no body');
  const bytes = await readBoundedBytes(response, maxBytes);
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

/**
 * The outcome of one provider request. `rejected` means the provider refused it (nothing was
 * applied); `unknown` means it may have been applied (408, 5xx, timeouts, transport failures).
 */
export type HttpJsonResult =
  | { kind: 'ok'; status: number; headers: Headers; body: Record<string, unknown> }
  | { kind: 'rejected'; status: number; retryable: boolean; reason: string; body?: unknown }
  | { kind: 'unknown'; status?: number; reason: string };

export interface HttpJsonRequest {
  method: string;
  headers?: Record<string, string>;
  /** Sent as `application/json`. */
  json?: unknown;
  /** Sent as `application/x-www-form-urlencoded`; arrays repeat the key. */
  form?: Record<string, string | readonly string[] | undefined>;
  body?: string;
}

export interface HttpJsonOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

export function formBody(form: NonNullable<HttpJsonRequest['form']>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue;
    for (const item of typeof value === 'string' ? [value] : value) params.append(key, item);
  }
  return params.toString();
}

function encode(request: HttpJsonRequest): { headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
  if (request.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    return { headers, body: JSON.stringify(request.json) };
  }
  if (request.form) {
    headers['content-type'] ??= 'application/x-www-form-urlencoded';
    return { headers, body: formBody(request.form) };
  }
  return { headers, body: request.body };
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * One JSON request through the host `NetPort`. 4xx → rejected (retryable only on 429);
 * 408, 5xx, malformed success bodies and timeouts → unknown. A caller abort rethrows.
 */
export async function httpJson(
  net: Pick<NetPort, 'fetch'>,
  url: string,
  request: HttpJsonRequest,
  options: HttpJsonOptions,
): Promise<HttpJsonResult> {
  const caller = options.signal ?? new AbortController().signal;
  const deadline = withDeadline(caller, options.timeoutMs, 'Provider request timed out');
  const maxBytes = options.maxBytes ?? 1_048_576;
  try {
    const { headers, body } = encode(request);
    let response: Response;
    try {
      response = await net.fetch(url, {
        method: request.method,
        headers,
        body,
        signal: deadline.signal,
      });
    } catch (error) {
      if (caller.aborted) throw abortError(caller);
      const timeout = deadline.signal.aborted;
      return { kind: 'unknown', reason: timeout ? 'timeout' : `transport: ${nameOf(error)}` };
    }
    const status = response.status;
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedBytes(response, maxBytes);
    } catch (error) {
      if (caller.aborted) throw abortError(caller);
      if (status >= 400 && status < 500 && status !== 408)
        return { kind: 'rejected', status, retryable: status === 429, reason: `HTTP ${status}` };
      return { kind: 'unknown', status, reason: `body: ${nameOf(error)}` };
    }
    if (status >= 200 && status < 300) {
      try {
        const parsed = parseJson(bytes);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return {
          kind: 'ok',
          status,
          headers: response.headers,
          body: parsed as Record<string, unknown>,
        };
      } catch {
        return { kind: 'unknown', status, reason: 'malformed JSON in a successful response' };
      }
    }
    if (status >= 400 && status < 500 && status !== 408) {
      let parsed: unknown;
      try {
        parsed = parseJson(bytes);
      } catch {
        parsed = undefined;
      }
      return {
        kind: 'rejected',
        status,
        retryable: status === 429,
        reason: `HTTP ${status}`,
        ...(parsed === undefined ? {} : { body: parsed }),
      };
    }
    return { kind: 'unknown', status, reason: `HTTP ${status}` };
  } finally {
    deadline.dispose();
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}
