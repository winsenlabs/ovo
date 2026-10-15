import { readBoundedJson } from '@winsendotai/ovo-plugin-kit';

/** Set on the error for a minted `ws_url` this plugin refuses to connect to. */
export const WS_URL_REJECTED = 'ws_url_rejected';

/**
 * A typed provider failure. `status` is the HTTP status; `code` is Rumik's machine-readable code
 * (`concurrency_limit_exceeded`, `insufficient_balance`, `INVALID_TEXT`, ...) when it sent one.
 */
export class RumikTtsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: string,
    /** From `Retry-After`: a per-key rate limit sets it; a full concurrency pool does not. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RumikTtsError';
  }
}

/**
 * 429 is retryable later: either the account's concurrent slots are all busy (4 on pay-as-you-go,
 * https://docs.rumik.ai/agent-limits) or the per-key rate limit was hit. 5xx is retryable. 402
 * (`insufficient_balance`, `access_blocked`) and the other 4xx (key, scope, validation) are not.
 */
export function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  return raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : undefined;
}

/** Error bodies are `{error, code}` (OpenAPI `Error`); only the code is kept, never the message. */
export async function responseError(response: Response, what: string): Promise<RumikTtsError> {
  let code: string | undefined;
  try {
    const body = await readBoundedJson(response, 4096);
    if (typeof body.code === 'string' && /^[\w.-]{1,64}$/.test(body.code)) code = body.code;
  } catch {
    // swallow-ok: a missing or malformed error body leaves the HTTP status as the whole story.
    await response.body?.cancel().catch(() => undefined);
  }
  return new RumikTtsError(
    `Rumik ${what} failed with HTTP ${response.status}${code ? `: ${code}` : ''}`,
    retryableStatus(response.status),
    response.status,
    code,
    retryAfter(response),
  );
}

/**
 * A socket `{error: true, code, recoverable}` frame. `INVALID_TEXT` and `INVALID_MESSAGE` are the
 * documented codes (https://docs.rumik.ai/streaming) and would fail again anywhere; any other code
 * is UNCONFIRMED and treated as a socket fault that a fresh socket or HTTP may not repeat.
 */
export function frameError(frame: Record<string, unknown>): RumikTtsError {
  const code = typeof frame.code === 'string' ? frame.code : 'UNKNOWN';
  const textual = code === 'INVALID_TEXT' || code === 'INVALID_MESSAGE';
  return new RumikTtsError(`Rumik TTS socket error: ${code}`, !textual, undefined, code);
}

/**
 * Whether `POST /v1/tts` may succeed where the socket path failed. Not after a refusal HTTP would
 * repeat (a bad key, an empty balance, unspeakable text); yes after a dropped, timed-out or busy
 * socket, a 5xx, or a minted `ws_url` this plugin would not connect to.
 */
export function httpMayHelp(error: unknown): boolean {
  if (!(error instanceof RumikTtsError)) return true;
  return error.retryable || error.code === WS_URL_REJECTED;
}

/** Close 1008 is a policy refusal: a fresh socket would get the same answer. */
export function retryableClose(code: number): boolean {
  return code !== 1008;
}
