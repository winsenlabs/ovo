import { ConnectorPolicyError, ToolInvocationError } from '@winsendotai/ovo-plugin-kit';
import { ResponseBodyLimitError } from '@winsendotai/ovo-plugin-tools-http';
import type { WebhookFailure, WebhookRequest, WebhookRetry } from './webhook-client.ts';

/** The longest `Retry-After` the client honours between attempts. */
export const RETRY_AFTER_MAX_MS = 10_000;

export const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });

/** The wait before attempt `n + 1`: `min(maxMs, baseMs * 2^(n-1))`, +-20 % jitter. */
export function backoffMs(retry: WebhookRetry, attempt: number, random: number): number {
  const base = Math.min(retry.maxMs, retry.baseMs * 2 ** (attempt - 1));
  return Math.round(base * (0.8 + random * 0.4));
}

/** Seconds (or an HTTP date) a response asks the sender to wait, capped; undefined when absent. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - now;
  return Number.isFinite(seconds) ? Math.min(RETRY_AFTER_MAX_MS, Math.max(0, seconds)) : undefined;
}

/** The code a transport error is recorded with, and whether trying again could help. */
export function classifyFailure(error: unknown): { reason: WebhookFailure; retry: boolean } {
  if (error instanceof ResponseBodyLimitError) return { reason: 'oversize', retry: false };
  if (error instanceof ConnectorPolicyError) return { reason: 'policy', retry: false };
  if (error instanceof ToolInvocationError && /redirect/i.test(error.message))
    return { reason: 'redirect', retry: false };
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return { reason: 'timeout', retry: true };
  return { reason: 'transport', retry: true };
}

const SECRET_HEADERS = /^(authorization|cookie|x-api-key|x-auth.*)$/i;

/** A request as a preview shows it (the API's test-webhook): no secret, query or credentials. */
export function redactWebhookRequest(request: WebhookRequest): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  const url = new URL(request.url);
  url.username = url.password = url.search = url.hash = '';
  const headers = Object.fromEntries(
    Object.entries({
      ...request.headers,
      'content-type': request.contentType,
      'idempotency-key': request.idempotencyKey,
      'x-ovo-signature': 'v1=<computed per attempt>',
    }).map(([name, value]) => [
      name,
      SECRET_HEADERS.test(name) || request.secretHeaders?.includes(name.toLowerCase())
        ? '<redacted>'
        : value,
    ]),
  );
  return { url: url.toString(), method: request.method, headers, body: request.body };
}
