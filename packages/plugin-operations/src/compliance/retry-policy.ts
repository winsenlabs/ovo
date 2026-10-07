import type { RetryOutcome, RetryRule, WorkspaceCompliance } from '@winsendotai/ovo-contracts';

/**
 * Intent-aware retries (compliance spec 3.7, [BP]): never after an opt-out, a wrong number, a
 * refusal or a dispute; back off after busy, no answer, voicemail and network failures. TRAI sets
 * no retry numbers; these are conservative defaults the workspace settings may change.
 */
const never: RetryRule = { retry: false, backoffMinutes: [], maxRetries: 0 };
export const DEFAULT_RETRY: Readonly<Record<RetryOutcome, RetryRule>> = Object.freeze({
  opted_out: never,
  wrong_number: never,
  refused: { ...never, cooloffDays: 30 },
  dispute: never,
  callback_requested: never,
  busy: { retry: true, backoffMinutes: [30, 120], maxRetries: 2 },
  no_answer: { retry: true, backoffMinutes: [120, 240, 1_440], maxRetries: 3 },
  voicemail: { retry: true, backoffMinutes: [1_440], maxRetries: 1 },
  failed: { retry: true, backoffMinutes: [15, 15], maxRetries: 2 },
  // Answered with no agent on the line: another try would add to the abandoned-call ratio (R18).
  abandoned: never,
  cancelled: never,
  unknown: never,
  connected: never,
});

/** Outcomes after which no campaign retry or redrive may dial the contact again. */
export const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set([
  'opted_out',
  'wrong_number',
  'refused',
  'dispute',
]);

/** What a terminal attempt status and its carrier reason amount to. */
export function attemptOutcome(status: string, reason?: string): RetryOutcome {
  if (status === 'succeeded') return 'connected';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'unknown' || status === 'superseded') return 'unknown';
  switch (reason) {
    case 'busy':
      return 'busy';
    case 'no_answer':
    case 'no-answer':
    // The status-callback path carries no reason: the longer no-answer backoff is the safe guess.
    case undefined:
      return 'no_answer';
    case 'voicemail':
    case 'machine':
      return 'voicemail';
    case 'completed_without_session':
      return 'abandoned';
    case 'canceled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

const BUILT_IN_DISPOSITIONS: Readonly<Record<string, RetryOutcome>> = Object.freeze({
  opted_out: 'opted_out',
  do_not_call_requested: 'opted_out',
  wrong_number: 'wrong_number',
  dispute_raised: 'dispute',
  dispute: 'dispute',
  abusive_caller: 'refused',
  refused: 'refused',
  not_interested: 'refused',
  callback: 'callback_requested',
  relief_team_callback: 'callback_requested',
});

/** A flow disposition as a retry outcome; the workspace map wins over the built-in names. */
export function dispositionOutcome(
  disposition: string,
  settings: Pick<WorkspaceCompliance, 'dispositionMap'>,
): RetryOutcome | undefined {
  return settings.dispositionMap[disposition] ?? BUILT_IN_DISPOSITIONS[disposition];
}

export function retryRule(outcome: RetryOutcome, settings: WorkspaceCompliance): RetryRule {
  return settings.retry[outcome] ?? DEFAULT_RETRY[outcome];
}

/** When the contact may be tried again after `previous` earlier tries ended the same way. */
export function retryAfter(
  outcome: RetryOutcome,
  previous: number,
  settings: WorkspaceCompliance,
  now: Date,
): Date | undefined {
  const rule = retryRule(outcome, settings);
  if (!rule.retry || previous >= rule.maxRetries || !rule.backoffMinutes.length) return undefined;
  const minutes = rule.backoffMinutes[Math.min(previous, rule.backoffMinutes.length - 1)]!;
  return new Date(now.getTime() + minutes * 60_000);
}
