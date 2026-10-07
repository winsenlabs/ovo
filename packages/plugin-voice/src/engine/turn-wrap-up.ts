import type { Clock } from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';

/** AgentWrapUp's default lead, and the longest the agent's current line may run on into it. */
export const WRAP_UP_LEAD_SECONDS = 15;
const FINISH_MS = 5_000;

export interface WrapUpConfig {
  line: string;
  leadSeconds?: number;
}

/**
 * Graceful max-duration wrap-up: `leadSeconds` before the watchdog would cut the call at
 * `maxCallSeconds`, `run` closes it with the wrap-up line. The watchdog stays armed behind it, so a
 * wrap-up that cannot finish still ends the call on time. Returns the cancel, if one was set.
 */
export function scheduleWrapUp(
  clock: Pick<Clock, 'setTimeout'>,
  maxCallSeconds: number,
  config: WrapUpConfig | undefined,
  run: (line: string, finishMs: number) => void,
): (() => void) | undefined {
  const lead = config?.leadSeconds ?? WRAP_UP_LEAD_SECONDS;
  if (!config?.line.trim() || maxCallSeconds <= lead) return undefined;
  const finishMs = Math.min(FINISH_MS, (lead * 1000) / 3);
  return clock.setTimeout(() => run(config.line, finishMs), (maxCallSeconds - lead) * 1000);
}

/**
 * Says the wrap-up line once the agent has stopped taking turns: no new line starts, a line
 * already reaching the caller finishes (at most `finishMs`, so the line is never cut off at the
 * limit instead), the rest is dropped, and `line` plays to its end.
 */
export async function closeCall(input: {
  speech: BoundedSpeechScheduler;
  clock: Pick<Clock, 'setTimeout'>;
  line: string;
  finishMs: number;
  /** Any barge-in flush still in flight. */
  settled: () => Promise<unknown>;
  live: () => boolean;
}): Promise<void> {
  const { speech } = input;
  speech.hold();
  let cancel: (() => void) | undefined;
  await Promise.race([
    speech.settled(),
    new Promise<void>((resolve) => (cancel = input.clock.setTimeout(resolve, input.finishMs))),
  ]);
  cancel?.();
  await input.settled();
  const epoch = await speech.beginEpoch();
  speech.release();
  if (input.live()) await speech.speak(input.line, { epoch, kind: 'response' });
}
