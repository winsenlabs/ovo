export type EndReason =
  | 'behavior_completed'
  | 'caller_hangup'
  | 'caller_idle'
  | 'voicemail'
  | 'max_duration'
  | 'transferred'
  | 'ownership_lost'
  | 'drain'
  | 'superseded'
  | `error:${string}`;

export type CallOutcome =
  | 'completed'
  | 'caller_ended'
  | 'no_input'
  | 'voicemail'
  | 'limit'
  | 'transferred'
  | 'canceled'
  | 'failed';

const OUTCOMES: Readonly<Record<string, CallOutcome>> = Object.freeze({
  behavior_completed: 'completed',
  caller_hangup: 'caller_ended',
  caller_idle: 'no_input',
  voicemail: 'voicemail',
  max_duration: 'limit',
  transferred: 'transferred',
  superseded: 'canceled',
});

/** A table, never substring matching (#20). drain, ownership_lost, error:* and anything unknown fail. */
export function outcomeFor(reason: EndReason): CallOutcome {
  return Object.hasOwn(OUTCOMES, reason) ? OUTCOMES[reason]! : 'failed';
}
