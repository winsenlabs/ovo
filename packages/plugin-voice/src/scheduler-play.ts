import { raceAbort } from './async.ts';
import type { SpeechEvidenceHistory } from './history.ts';
import type { SpeechHold, TakenBack } from './scheduler-hold.ts';
import type { QueueEntry, SpeechSettlement } from './scheduler-settlement.ts';
import type { SpeechOutput, SpeechOutputResult } from './types.ts';

/** What one line's playback needs from the scheduler. */
export interface LinePlayback {
  output: SpeechOutput;
  holds: SpeechHold;
  evidence: SpeechEvidenceHistory;
  settlement: SpeechSettlement;
  /** Lines the output is preparing or playing, each with the controller it plays under. */
  active: Map<QueueEntry, AbortController>;
  timeoutMs: number;
  epoch: () => number;
}

/**
 * Plays one line through the output and settles it; a line taken back for the caller (P1) is not
 * settled, and the result says how it left the output.
 */
export async function playLine(
  lines: LinePlayback,
  entry: QueueEntry,
): Promise<TakenBack | undefined> {
  const { output, holds, evidence, settlement } = lines;
  const controller = entry.controller;
  lines.active.set(entry, controller);
  evidence.record(entry.segment, 'started', 'generated');
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('speech playback timed out', 'TimeoutError'));
  }, lines.timeoutMs);
  timeout.unref?.();

  let playing: Promise<SpeechOutputResult> | undefined;
  try {
    const preparing = output.prepare?.(entry.segment, controller.signal);
    if (preparing) await raceAbort(preparing, controller.signal);
    // Taken back before the output began playing it: nothing was aborted, the preparation stands.
    if (entry.held) return { kept: true };
    entry.playing = true;
    playing = output.play(entry.segment, {
      signal: controller.signal,
      report: (phase, reported) => {
        if (holds.reported(entry, phase)) evidence.record(entry.segment, phase, reported);
      },
    });
    const result = await raceAbort(playing, controller.signal);
    if (entry.held) return { kept: false, playing };
    const current = entry.segment.epoch === lines.epoch() && !controller.signal.aborted;
    settlement.finished(entry, result, current);
  } catch (error) {
    const taken = holds.takenBack(entry, playing, controller.signal.aborted);
    if (taken) return taken;
    await settlement.failed(entry, controller.signal, error, (epoch) => output.interrupt(epoch));
  } finally {
    clearTimeout(timeout);
    entry.playing = false;
    if (lines.active.get(entry) === controller) lines.active.delete(entry);
  }
  return undefined;
}
