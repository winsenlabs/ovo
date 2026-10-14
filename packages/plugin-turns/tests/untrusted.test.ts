import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { SpeechCapabilities, TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '../src/index.ts';

// Wave 8, call 6e1a4e3a in a noisy cafe: "Hardik?" after 9.4 s of noise and "Credit. Okay, so..."
// were answered as clear words. turn.stopped now says when the words are doubtful.

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

/** Scribe with commit_strategy=manual. */
const scribe: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};

function fixture() {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  const controller = createTurnDetector({}).create({
    clock,
    vad: true,
    language: 'en-IN',
    mode: 'agent',
    stt: scribe,
  });
  controller.on((decision) => decisions.push(decision));
  let revision = 0;
  let segment = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final', confidence?: number) =>
    send({
      type: 'stt',
      event: {
        type: 'transcript',
        segment: {
          segmentId: `s${segment}`,
          revision: ++revision,
          text,
          stability,
          ...(confidence === undefined ? {} : { confidence }),
        },
      },
    });
  /**
   * VAD speech of `ms` with interims, then the stop, the forced commit and the final, and `afterMs`
   * of silence.
   */
  const utter = (
    ms: number,
    interims: readonly string[],
    final: string,
    confidence?: number,
    afterMs = 1000,
  ) => {
    segment++;
    send({ type: 'vad.start' });
    for (const text of interims) {
      transcript(text, 'interim');
      clock.advance(ms / interims.length);
    }
    send({ type: 'vad.stop' });
    for (let waited = 0; waited < 5000 && !forced(); waited += 10) clock.advance(10);
    clock.advance(350);
    transcript(final, 'final', confidence);
    clock.advance(afterMs);
  };
  let commits = 0;
  const forced = () => {
    const now = decisions.filter((d) => d.type === 'force-endpoint').length;
    if (now === commits) return false;
    commits = now;
    return true;
  };
  const stopped = () =>
    decisions.flatMap((d) => (d.type === 'turn.stopped' ? [[d.input, d.untrusted] as const] : []));
  return { utter, stopped };
}

describe('doubtful caller turns (Wave 8)', () => {
  it('a final the STT doubted is untrusted', () => {
    const f = fixture();
    f.utter(600, ['Hardik'], 'Hardik?', 0.12);
    expect(f.stopped()).toEqual([
      [{ kind: 'speech', text: 'Hardik?', segments: 1 }, 'low-confidence'],
    ]);
  });

  it('seconds of cafe noise that gave one word are untrusted', () => {
    const f = fixture();
    // The noise kept the VAD open, and the interim changing, for nine seconds.
    const noise = ['Har', 'Hardi', 'Hardik', 'Hard', 'Hardik', 'Har dick', 'Hardik', 'Hardi'];
    f.utter(9_000, [...noise, 'Hardik?'], 'Hardik?');
    expect(f.stopped().map(([, untrusted]) => untrusted)).toEqual(['low-information']);
  });

  it('a few words trailing off are untrusted, a clear reply is heard', () => {
    const f = fixture();
    // Wave 12: broken off, it waits the 2.5 s pause hold before it ends as a turn of its own.
    f.utter(900, ['Credit', 'Credit okay'], 'Credit. Okay, so...', undefined, 2_600);
    f.utter(1_800, ['Can you check', 'Can you check flights'], 'Can you check for flights?', 0.93);
    expect(f.stopped().map(([, untrusted]) => untrusted)).toEqual(['fragment', undefined]);
  });
});
