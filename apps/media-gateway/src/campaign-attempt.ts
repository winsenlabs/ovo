import type { NormalizedCallEvent } from '@winsendotai/ovo-contracts';

/** A completed carrier leg is successful only after a real session opened and no machine answered. */
export function campaignAttemptStatus(input: {
  state: NormalizedCallEvent['state'];
  answeredBy?: NormalizedCallEvent['answeredBy'];
  sessionOpened: boolean;
}): 'dialing' | 'connected' | 'succeeded' | 'cancelled' | 'failed' {
  if (input.state === 'in_progress') return 'connected';
  if (input.state === 'completed')
    return input.sessionOpened && input.answeredBy !== 'machine' ? 'succeeded' : 'failed';
  if (input.state === 'canceled') return 'cancelled';
  if (input.state === 'busy' || input.state === 'failed' || input.state === 'no_answer')
    return 'failed';
  return 'dialing';
}

/** Why a campaign attempt failed, for the retry policy; undefined when it did not fail. */
export function campaignAttemptReason(input: {
  state: NormalizedCallEvent['state'];
  answeredBy?: NormalizedCallEvent['answeredBy'];
  sessionOpened: boolean;
}): string | undefined {
  if (input.state === 'busy' || input.state === 'no_answer' || input.state === 'failed')
    return input.state;
  if (input.state !== 'completed') return undefined;
  if (input.answeredBy === 'machine') return 'voicemail';
  return input.sessionOpened ? undefined : 'completed_without_session';
}
