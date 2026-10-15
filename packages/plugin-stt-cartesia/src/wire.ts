import type { AudioFormat } from '@winsendotai/ovo-contracts';

// Wire facts of both realtime endpoints, from
// https://docs.cartesia.ai/api-reference/stt/turns/websocket.md and
// https://docs.cartesia.ai/api-reference/stt/websocket.md (both retrieved 2026-10-13).

export const CARTESIA_HOST = 'api.cartesia.ai';
/** The only value the `cartesia_version` enum lists on both STT endpoints. */
export const CARTESIA_VERSION = '2026-08-14';
export const AUTO_PATH = '/stt/turns/websocket';
export const MANUAL_PATH = '/stt/websocket';

/** A typed Ink failure; `code` is the error event's `error_code`, its status, or a close code. */
export class CartesiaSttError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CartesiaSttError';
  }
}

/** Raw sample encodings the endpoints take for OVO's native formats (no header, no container). */
export function encodingOf(format: AudioFormat): 'pcm_mulaw' | 'pcm_s16le' {
  return format.encoding === 'mulaw' ? 'pcm_mulaw' : 'pcm_s16le';
}

const FATAL_CODES = new Set([
  'quota_exceeded',
  'model_not_found',
  'language_not_supported',
  'unsupported_audio_format',
  'plan_upgrade_required',
]);

/**
 * An `error` event (`status_code`, `error_code`, `title`, `message`, `request_id`). Concurrency
 * (429) and server errors are worth the host's reconnect; account and request errors are not.
 * The message carries the code, status and request id only, never caller words.
 */
export function eventError(event: Record<string, unknown>): CartesiaSttError {
  const status = typeof event.status_code === 'number' ? event.status_code : 0;
  const code = typeof event.error_code === 'string' ? event.error_code : undefined;
  const request = typeof event.request_id === 'string' ? ` request_id=${event.request_id}` : '';
  const retryable =
    !(code && FATAL_CODES.has(code)) &&
    (code === 'concurrency_limited' || status === 429 || status >= 500);
  return new CartesiaSttError(
    `Cartesia STT ${code ?? 'error'} (${status || '?'})${request}`,
    code ?? status,
    retryable,
  );
}

/** A close the provider initiated. A policy close is final; a drop may reconnect. */
export function closeFailure(code: number, reason: string): CartesiaSttError {
  const final = code === 1008 || code === 4001 || code === 4003;
  return new CartesiaSttError(
    `Cartesia STT closed (${code})${reason ? `: ${reason}` : ''}`,
    code,
    !final,
  );
}

/** A transport error; a refused handshake names its HTTP status ("Unexpected server response"). */
export function transportFailure(error: Error): CartesiaSttError {
  const status = Number(/server response: (\d{3})/.exec(error.message)?.[1]);
  if (Number.isFinite(status))
    return new CartesiaSttError(
      `Cartesia STT handshake refused (${status})`,
      status,
      status === 429 || status >= 500,
    );
  return new CartesiaSttError(`Cartesia STT transport error: ${error.message}`, 1006, true);
}

/** A JSON object event, or undefined for anything else (binary, malformed, not an object). */
export function parseEvent(
  data: string | Uint8Array,
  binary: boolean,
): Record<string, unknown> | undefined {
  if (binary) return undefined;
  try {
    const value: unknown = JSON.parse(String(data));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    // swallow-ok: the caller fails the session on a malformed event.
    return undefined;
  }
}

/** Builds a query string with spaces as `%20`, as the keyterm docs ask (not `+`). */
export function query(params: readonly [string, string | number][]): string {
  return params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}
