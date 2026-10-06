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

/**
 * The live-path stage a call timed out in (OBS-9), so a drop at call start is never blamed on the
 * carrier when the route lookup or the worker was slow: the carrier never sent its start frame,
 * the gateway resolved the route or dialled the worker, media went idle, the worker opened the
 * session, or a provider stage of a turn.
 */
export const TIMEOUT_STAGES = [
  'carrier_start',
  'route_resolve',
  'worker_dial',
  'media_idle',
  'session_open',
  'stt',
  'tts',
  'llm',
  'decision',
  'tool',
] as const;
export type TimeoutStage = (typeof TIMEOUT_STAGES)[number];

const PROVIDER = /^[A-Za-z0-9._@/-]{1,100}$/;

/** `error:timeout:<stage>[:<provider>]`; a provider name that is not a plain identifier is left out. */
export function timeoutReason(stage: TimeoutStage, provider?: string): EndReason {
  return `error:timeout:${stage}${provider && PROVIDER.test(provider) ? `:${provider}` : ''}`;
}

/** Earlier spellings, kept readable so old calls still say which stage timed out. */
const LEGACY_TIMEOUTS: Readonly<Record<string, TimeoutStage>> = Object.freeze({
  'error:carrier start timeout': 'carrier_start',
  'error:media idle timeout': 'media_idle',
});

/**
 * Which stage (and provider) a call's end reason says timed out, or undefined when it did not time
 * out. Reads `timeoutReason` output, a session-open failure whose cause timed out
 * (`error:session-open-failed:<stage>:[<kind>/<provider>: ]… timed out`), and legacy gateway text.
 */
export function timeoutOf(reason: string): { stage: string; provider?: string } | undefined {
  const typed = /^error:timeout:([a-z_]{1,40})(?::([^\s:]{1,100}))?$/.exec(reason);
  if (typed) return { stage: typed[1]!, ...(typed[2] ? { provider: typed[2] } : {}) };
  if (Object.hasOwn(LEGACY_TIMEOUTS, reason)) return { stage: LEGACY_TIMEOUTS[reason]! };
  const opened = /^error:session-open-failed:[a-z]+:(?:([A-Za-z0-9._@/-]{1,100}): )?(.*)$/s.exec(
    reason,
  );
  if (opened && /\btime(?:d)?[\s_-]?out\b|\btimeout\b|ETIMEDOUT/i.test(opened[2]!))
    return { stage: 'session_open', ...(opened[1] ? { provider: opened[1] } : {}) };
  return undefined;
}
