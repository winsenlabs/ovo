import type { AudioFormat } from '@winsendotai/ovo-contracts';

/** A typed Sonic failure. `status` is the error event's `status_code` or a WebSocket close code. */
export class CartesiaTtsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CartesiaTtsError';
  }
}

/**
 * Codes that fail the same way on every attempt: account, voice, model and request problems
 * (https://docs.cartesia.ai/use-the-api/api-errors.md, retrieved 2026-10-13). Unknown codes are
 * tolerated and judged by their status.
 */
const FATAL_CODES = new Set([
  'quota_exceeded',
  'voice_model_mismatch',
  'voice_not_found',
  'model_not_found',
  'language_not_supported',
  'file_too_large',
  'unsupported_audio_format',
  'plan_upgrade_required',
  'model_sunsetted',
]);

/** `concurrency_limited` (429) and server errors are worth a fresh context after a pause. */
export function isRetryable(status: number | undefined, code: string | undefined): boolean {
  if (code && FATAL_CODES.has(code)) return false;
  if (code === 'concurrency_limited') return true;
  return status === 429 || (status !== undefined && status >= 500);
}

/**
 * An `error` event, described by its code, title, status and request id only: never the
 * transcript, which the provider does not echo anyway.
 */
export function eventError(event: Record<string, unknown>): CartesiaTtsError {
  const status = typeof event.status_code === 'number' ? event.status_code : undefined;
  const code = typeof event.error_code === 'string' ? event.error_code : undefined;
  const title = typeof event.title === 'string' ? event.title : 'error';
  const request = typeof event.request_id === 'string' ? ` request_id=${event.request_id}` : '';
  return new CartesiaTtsError(
    `Cartesia TTS ${code ?? 'error'} (${status ?? '?'}): ${title}${request}`,
    isRetryable(status, code),
    status,
    code,
  );
}

/** A policy close (bad key, refused) is final; any other close may succeed on a new socket. */
export function closeError(code: number, reason: string): CartesiaTtsError {
  const final = code === 1008 || code === 4001 || code === 4003;
  return new CartesiaTtsError(
    `Cartesia TTS socket closed (${code})${reason ? `: ${reason}` : ''}`,
    !final,
    code,
  );
}

/**
 * A transport error. `ws` reports a refused handshake as "Unexpected server response: <status>";
 * 401/403 are the key, 429 is the connection cap (10x the plan's concurrency) and stays retryable.
 */
export function transportError(error: Error): CartesiaTtsError {
  const status = Number(/server response: (\d{3})/.exec(error.message)?.[1]);
  if (Number.isFinite(status))
    return new CartesiaTtsError(
      `Cartesia TTS handshake refused (${status})`,
      status === 429 || status >= 500,
      status,
    );
  return new CartesiaTtsError(`Cartesia TTS socket error: ${error.message}`, true);
}

export function asTtsError(error: unknown): CartesiaTtsError | Error {
  if (error instanceof CartesiaTtsError) return error;
  return error instanceof Error ? error : new Error(String(error));
}

/** A failure as a typed one: unknown errors become retryable, aborts stay aborts. */
export function asCartesiaError(error: unknown): CartesiaTtsError | Error {
  const known = asTtsError(error);
  return known instanceof CartesiaTtsError || known.name === 'AbortError'
    ? known
    : new CartesiaTtsError(known.message, true);
}

/**
 * Keeps provider audio in whole samples. A base64 chunk of PCM16 may end on an odd byte, and a
 * half sample handed on would click; the odd byte is held for the next chunk.
 */
export class WholeSamples {
  private held: number | undefined;
  private readonly pcm: boolean;

  constructor(format: AudioFormat) {
    this.pcm = format.encoding === 'pcm_s16le';
  }

  take(chunk: Uint8Array): Uint8Array {
    if (!this.pcm) return chunk;
    const prefix = this.held === undefined ? 0 : 1;
    const total = prefix + chunk.byteLength;
    const even = total - (total % 2);
    const out = new Uint8Array(even);
    if (prefix && even) out[0] = this.held!;
    out.set(chunk.subarray(0, even - prefix), prefix);
    this.held =
      total % 2 ? (chunk.byteLength ? chunk[chunk.byteLength - 1] : this.held) : undefined;
    return out;
  }

  /** True when the stream stopped mid-sample. */
  get partial(): boolean {
    return this.held !== undefined;
  }
}
