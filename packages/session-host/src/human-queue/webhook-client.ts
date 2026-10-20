import { randomUUID } from 'node:crypto';
import {
  createPinnedFetch,
  type SecureNetworkDependencies,
} from '@winsendotai/ovo-plugin-tools-http';
import { webhookSignature } from './signature.ts';
import { backoffMs, classifyFailure, realSleep, retryAfterMs } from './webhook-support.ts';

/** The most a human queue's third party may answer (human queue design 7.4). */
export const HUMAN_QUEUE_RESPONSE_MAX_BYTES = 16 * 1024;
/** The one best-effort `cancelled` post gets this long and is never retried. */
export const CANCEL_TIMEOUT_MS = 3_000;
export const WEBHOOK_USER_AGENT = 'ovo-human-queue/1';

export interface WebhookRetry {
  attempts: number;
  baseMs: number;
  maxMs: number;
  /** All attempts and the waits between them. */
  deadlineMs: number;
}

export interface WebhookRequest {
  url: string;
  method: 'POST' | 'PUT';
  contentType: string;
  /** The exact bytes to send and to sign. */
  body: string;
  /** Static headers and the resolved extra-auth header; OVO's own are added (and win). */
  headers?: Readonly<Record<string, string>>;
  /** The HMAC signing secret. */
  secret: string;
  /** Lower-case names of `headers` that carry a credential, for `redactWebhookRequest`. */
  secretHeaders?: readonly string[];
  /** The same on every attempt. */
  idempotencyKey: string;
  /** Per attempt. */
  timeoutMs: number;
  retry: WebhookRetry;
  /** The hold running out, or the call ending: no further attempt starts once it fires. */
  signal?: AbortSignal;
}

/** Why a delivery failed: a code, never a URL, host or message. */
export type WebhookFailure =
  | 'timeout'
  | 'transport'
  | 'oversize'
  | 'redirect'
  | 'policy'
  | 'invalid'
  | 'deadline'
  | 'aborted'
  | `http_${number}`;

export interface WebhookAttempt {
  /** 1-based. */
  attempt: number;
  outcome: 'delivered' | 'retry' | 'failed';
  status?: number;
  ms: number;
  reason?: WebhookFailure;
}

export type WebhookOutcome =
  | { ok: true; status: number; json: unknown; attempts: number }
  | { ok: false; reason: WebhookFailure; status?: number; attempts: number };

export interface WebhookDeps {
  /** Test injection (DNS lookup, fetch); production resolves and pins with Undici. */
  network?: Pick<SecureNetworkDependencies, 'lookup' | 'fetch'>;
  /** Epoch ms. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** In [0, 1). */
  random?: () => number;
  requestId?: () => string;
  onAttempt?: (attempt: WebhookAttempt) => void;
  maxResponseBytes?: number;
}

/**
 * One signed delivery to a human queue's third party (human queue design 7.4 steps 1-2). Each
 * attempt is a fresh pinned fetch (https only, a public address resolved and pinned, no redirects,
 * at most 16 KiB back) with its own timestamp and signature, the same request id and the same
 * `Idempotency-Key`. A network error, a timeout, a 5xx, a 408 and a 429 are retried with
 * exponential backoff and jitter (a `Retry-After` of up to ten seconds raises the wait) while
 * attempts and the deadline last; any other 4xx, a policy refusal, an oversize body and a
 * redirect fail at once. A 2xx whose body is not JSON is `invalid` and not retried.
 */
export async function sendWebhook(
  request: WebhookRequest,
  deps: WebhookDeps = {},
): Promise<WebhookOutcome> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const requestId = deps.requestId?.() ?? randomUUID();
  const startedAt = now();
  let last: WebhookFailure = 'transport';
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= request.retry.attempts; attempt += 1) {
    const left = request.retry.deadlineMs - (now() - startedAt);
    if (request.signal?.aborted) return failed('aborted', attempt - 1);
    if (left <= 0) return failed(attempt === 1 ? 'deadline' : last, attempt - 1, lastStatus);
    const began = now();
    const result = await attemptOnce(
      request,
      deps,
      requestId,
      attempt,
      Math.min(request.timeoutMs, left),
    );
    const ms = Math.max(0, now() - began);
    if (result.kind === 'response' && result.status >= 200 && result.status < 300) {
      if (result.invalid) {
        deps.onAttempt?.({
          attempt,
          outcome: 'failed',
          status: result.status,
          ms,
          reason: 'invalid',
        });
        return failed('invalid', attempt, result.status);
      }
      deps.onAttempt?.({ attempt, outcome: 'delivered', status: result.status, ms });
      return { ok: true, status: result.status, json: result.json, attempts: attempt };
    }
    const retryable =
      result.kind === 'response'
        ? [408, 429].includes(result.status) || result.status >= 500
        : result.retry;
    last = result.kind === 'response' ? `http_${result.status}` : result.reason;
    lastStatus = result.kind === 'response' ? result.status : undefined;
    const wait = waitBefore(request, deps, attempt, result, now());
    const more = attempt < request.retry.attempts;
    const fits = request.retry.deadlineMs - (now() - startedAt) > wait;
    deps.onAttempt?.({
      attempt,
      outcome: retryable && more && fits ? 'retry' : 'failed',
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      ms,
      reason: last,
    });
    if (!retryable || !more || !fits) return failed(last, attempt, lastStatus);
    await sleep(wait, request.signal);
  }
  return failed(last, request.retry.attempts, lastStatus);
}

/** The best-effort `cancelled` post (design 7.4 step 6): one attempt, three seconds, no retry. */
export function sendCancel(
  request: WebhookRequest,
  deps: WebhookDeps = {},
): Promise<WebhookOutcome> {
  return sendWebhook(
    {
      ...request,
      timeoutMs: Math.min(request.timeoutMs, CANCEL_TIMEOUT_MS),
      retry: { ...request.retry, attempts: 1, deadlineMs: CANCEL_TIMEOUT_MS },
    },
    deps,
  );
}

type Attempted =
  | { kind: 'response'; status: number; json: unknown; invalid: boolean; retryAfter: string | null }
  | { kind: 'error'; reason: WebhookFailure; retry: boolean };

async function attemptOnce(
  request: WebhookRequest,
  deps: WebhookDeps,
  requestId: string,
  attempt: number,
  timeoutMs: number,
): Promise<Attempted> {
  const timestamp = String(Math.floor((deps.now ?? Date.now)() / 1000));
  let pinned;
  try {
    pinned = await createPinnedFetch(request.url, {
      ...deps.network,
      maxResponseBytes: deps.maxResponseBytes ?? HUMAN_QUEUE_RESPONSE_MAX_BYTES,
    });
  } catch (error) {
    return { kind: 'error', ...classifyFailure(error) };
  }
  try {
    const signals = [AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])];
    const response = await pinned.fetch(request.url, {
      method: request.method,
      headers: {
        ...request.headers,
        'content-type': request.contentType,
        'user-agent': WEBHOOK_USER_AGENT,
        'idempotency-key': request.idempotencyKey,
        'x-ovo-request-id': requestId,
        'x-ovo-attempt': String(attempt),
        'x-ovo-timestamp': timestamp,
        'x-ovo-signature': webhookSignature(request.secret, timestamp, requestId, request.body),
      },
      body: request.body,
      signal: AbortSignal.any(signals),
    });
    const retryAfter = response.headers.get('retry-after');
    if (response.status < 200 || response.status > 299) {
      // Not awaited: an error body is not worth waiting on, and a cancel can wait on a tee'd reader.
      void response.body?.cancel().catch(() => undefined);
      return {
        kind: 'response',
        status: response.status,
        json: undefined,
        invalid: false,
        retryAfter,
      };
    }
    const text = await response.text();
    const parsed = parseBody(text);
    return { kind: 'response', status: response.status, retryAfter, ...parsed };
  } catch (error) {
    return { kind: 'error', ...classifyFailure(error) };
  } finally {
    await pinned.dispose().catch(() => undefined);
  }
}

function parseBody(text: string): { json: unknown; invalid: boolean } {
  if (!text.trim()) return { json: undefined, invalid: false };
  try {
    return { json: JSON.parse(text), invalid: false };
  } catch {
    return { json: undefined, invalid: true };
  }
}

function waitBefore(
  request: WebhookRequest,
  deps: WebhookDeps,
  attempt: number,
  result: Attempted,
  now: number,
): number {
  const backoff = backoffMs(request.retry, attempt, (deps.random ?? Math.random)());
  const asked = result.kind === 'response' ? retryAfterMs(result.retryAfter, now) : undefined;
  return Math.max(backoff, asked ?? 0);
}

function failed(reason: WebhookFailure, attempts: number, status?: number): WebhookOutcome {
  return { ok: false, reason, attempts, ...(status !== undefined ? { status } : {}) };
}
