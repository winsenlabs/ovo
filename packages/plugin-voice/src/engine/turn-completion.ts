import { TRANSFER_REASON_PREFIX, type Behavior } from '@winsendotai/ovo-contracts';

export type DriverEndReason =
  'behavior_completed' | 'caller_idle' | 'voicemail' | 'transferred' | 'error:turn';

/**
 * How a behaviour that has completed ends the call, with its completion reason as the detail. A
 * `transfer:` reason (AGT-15) ends it `transferred`, so the host hands the carrier leg on instead
 * of hanging it up; an idle turn ends it `caller_idle`.
 */
export function completionEnd(
  behavior: Pick<Behavior, 'completionReason'>,
  extra: Readonly<Record<string, unknown>>,
): [DriverEndReason, string | undefined] {
  const detail = behavior.completionReason?.();
  if (detail?.startsWith(TRANSFER_REASON_PREFIX)) return ['transferred', detail];
  return [extra.inputEvent === 'idle' ? 'caller_idle' : 'behavior_completed', detail];
}
