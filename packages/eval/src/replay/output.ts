// The speech output of a replay: synthesis and playout timed, never sounded. A line's first audio
// reaches the carrier `firstByteMs` after it is played (at once for a cached filler or the opening,
// as the pinned clips did live) and it plays for `msPerChar` per character, so barge-ins, holds and
// supersessions happen when they would have. Its timing reaches the engine as the real output's
// does: `tts-first-byte`, `carrier-first-audio`, then `sent`.
import type { Clock, SpeechOutput, SpeechSegment } from '@winsendotai/ovo-contracts';
import type { AgentProfile } from '../corpus/profile.ts';
import type { CallTimeline } from '../timeline.ts';

/** plugin-voice's SpeechTimingSink (not exported from its index). */
type SpeechTimingSink = (
  phase: 'text-ready' | 'tts-first-byte' | 'carrier-first-audio',
  segment: SpeechSegment,
  elapsedMs?: number,
) => void;

export interface OutputTiming {
  firstByteMs: number;
  msPerChar: number;
  /** Lines with no synthesis wait: fillers, the opening, the disclosure. */
  cached: readonly string[];
}

/** The output's timing: the profile's, with the speaking rate measured on the live call when it can be. */
export function outputTiming(profile: AgentProfile, live?: CallTimeline): OutputTiming {
  const rates = (live?.agent ?? [])
    .filter(
      (line) =>
        line.outcome === 'completed' && line.audibleAtMs !== undefined && line.text.length >= 20,
    )
    .map((line) => (line.endedAtMs! - line.audibleAtMs!) / line.text.length)
    .sort((a, b) => a - b);
  const opening = (profile.agent.opening as { lines?: string[] } | undefined)?.lines ?? [];
  return {
    firstByteMs: profile.tts.firstByteMs,
    msPerChar: rates.length >= 5 ? rates[rates.length >> 1]! : profile.tts.msPerChar,
    cached: [...profile.fillers, ...opening, ...(profile.askToEnd ? [profile.askToEnd] : [])],
  };
}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const cancel = clock.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        cancel();
        resolve();
      },
      { once: true },
    );
  });
}

export class TimedOutput implements SpeechOutput {
  private timing?: SpeechTimingSink;

  constructor(
    private readonly clock: Clock,
    private readonly options: OutputTiming,
  ) {}

  configureTiming(sink: SpeechTimingSink): void {
    this.timing = sink;
  }

  async play(
    segment: SpeechSegment,
    { signal, report }: Parameters<SpeechOutput['play']>[1],
  ): ReturnType<SpeechOutput['play']> {
    const cached =
      String(segment.kind) === 'disclosure' || this.options.cached.includes(segment.text.trim());
    await wait(this.clock, cached ? 2 : this.options.firstByteMs, signal);
    if (signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
    if (!cached) this.timing?.('tts-first-byte', segment);
    this.timing?.('carrier-first-audio', segment);
    report?.('sent', 'estimated');
    await wait(this.clock, Math.max(200, segment.text.length * this.options.msPerChar), signal);
    return signal.aborted
      ? { state: 'interrupted', evidence: 'estimated' }
      : { state: 'completed', evidence: 'confirmed' };
  }

  async interrupt(): Promise<void> {}
}
