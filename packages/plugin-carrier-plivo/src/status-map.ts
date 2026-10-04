import type { CallState } from '@winsendotai/ovo-contracts';

export const PLIVO_STATUS_MAP: Readonly<Record<string, CallState>> = {
  queued: 'queued',
  ringing: 'ringing',
  ring: 'ringing',
  'in-progress': 'in_progress',
  in_progress: 'in_progress',
  answered: 'in_progress',
  completed: 'completed',
  hangup: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  failed: 'failed',
  canceled: 'canceled',
  cancelled: 'canceled',
};

export function plivoStatus(raw: string): CallState | undefined {
  return PLIVO_STATUS_MAP[raw.trim().toLowerCase()];
}

/** Plivo CDR call_state is legacy; hangup_cause_name records the outcome. */
export function plivoCdrStatus(
  cause: string,
): Extract<CallState, 'completed' | 'failed' | 'canceled' | 'busy' | 'no_answer'> | undefined {
  const value = cause.trim().toLowerCase();
  if (value === 'normal hangup' || value === 'end of xml instructions') return 'completed';
  if (value.startsWith('canceled')) return 'canceled';
  if (value === 'no answer' || value === 'ring timeout reached') return 'no_answer';
  if (value === 'busy line' || value === 'busy everywhere') return 'busy';
  if (
    value === 'invalid destination address' ||
    value === 'rejected' ||
    value === 'network error' ||
    value === 'internal error' ||
    value === 'routing error'
  )
    return 'failed';
  return undefined;
}

export function answeredBy(raw: string | undefined): 'human' | 'machine' | 'unknown' | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === 'machine') return 'machine';
  if (value === 'false' || value === 'human') return 'human';
  return 'unknown';
}
