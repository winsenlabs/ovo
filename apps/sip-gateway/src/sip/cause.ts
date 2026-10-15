import type { CallState } from '@winsendotai/ovo-contracts';

/**
 * An outbound INVITE's final response as a `CallState` (W11 §5.4). `487` depends on who cancelled:
 * our ring timeout means nobody answered, a host hangup means the call was cancelled.
 */
export function finalToState(
  status: number,
  cancelledBy?: 'ring-timeout' | 'host',
): { state: Exclude<CallState, 'queued' | 'ringing'>; retryable: boolean } {
  if (status >= 200 && status < 300) return { state: 'in_progress', retryable: false };
  if (status === 487)
    return cancelledBy === 'host'
      ? { state: 'canceled', retryable: false }
      : { state: 'no_answer', retryable: false };
  if (status === 486 || status === 600) return { state: 'busy', retryable: false };
  if (status === 408 || status === 480) return { state: 'no_answer', retryable: false };
  if (status >= 500 && status < 600) return { state: 'failed', retryable: true };
  return { state: 'failed', retryable: false };
}

/** `Reason: Q.850;cause=16;text="..."` → 16. Logged only; the RFC 3398 table is UNCONFIRMED. */
export function q850Cause(reason: string | undefined): number | undefined {
  const match = /^\s*Q\.850\s*;.*\bcause\s*=\s*(\d{1,3})/i.exec(reason ?? '');
  return match ? Number(match[1]) : undefined;
}

/** Normal call clearing, used on our BYEs (drain, media timeout, session expiry). */
export const NORMAL_CLEARING = 'Q.850;cause=16;text="Normal call clearing"';

/** `Retry-After: 30 (comment);duration=…` → 30. */
export function retryAfterSeconds(value: string | undefined): number | undefined {
  const match = /^\s*(\d{1,6})/.exec(value ?? '');
  return match ? Number(match[1]) : undefined;
}
