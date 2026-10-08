import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { LIVE, MAYA, replay } from './replay.ts';

describe('call-3 #6: no endpoint held for seconds', () => {
  /**
   * Call 6e1a4e3a turn 9 traced: the 9.4 s was not the VAD. "Hardik?" (said 2.4 s into a 12 s
   * answer that ended on a question, its final in 1.85 s later) waited, as AGT-9's answer to that
   * question, until the agent stopped 9.4 s after it.
   */
  const turn9 = (row: Record<string, unknown>, agentAfterMs: number) => {
    const f = replay(new FakeClock(), row);
    f.agentStarts(true);
    f.clock.advance(2400);
    f.commits('Hardik?', 347);
    f.interim('Hardik?');
    f.clock.advance(agentAfterMs);
    f.agentStops();
    f.clock.advance(5000);
    return f;
  };

  it('turn 9: the replay matches the live 9426 ms', () => {
    const f = turn9(LIVE, 9426);
    expect(f.turns).toEqual([
      expect.objectContaining({ text: 'Hardik?', endpointMs: 9426, reason: 'agent' }),
    ]);
  });

  it('turn 9 now: words said long before the question was heard only acknowledged the agent', () => {
    const f = turn9(MAYA, 9426);
    expect(f.turns).toEqual([]);
    expect(f.resets).toEqual(['backchannel']);
  });

  it('a short reply said within 6 s of the agent stopping still answers its question', () => {
    // Call 6e1a4e3a turn-1: "हाँ।" 1.8 s before the end of the greeting, which asked something.
    const f = turn9(MAYA, 1836);
    expect(f.turns).toEqual([
      expect.objectContaining({ text: 'Hardik?', endpointMs: 1836, reason: 'agent' }),
    ]);
    expect(turn9(MAYA, 6000).turns).toHaveLength(1);
    expect(turn9(MAYA, 6001).turns).toHaveLength(0);
  });

  /**
   * Café noise the VAD cannot tell from speech: it starts again right after the commit, so the
   * live detector reopened the turn and waited for a VAD stop that came only when the noise did.
   */
  const flapping = (row: Record<string, unknown>) => {
    const f = replay(new FakeClock(), row);
    f.send({ type: 'vad.start' });
    f.clock.advance(3000);
    f.commits("I'm in a coffee shop.", 398);
    f.interim("I'm in a coffee shop.");
    f.clock.advance(1500 + 50);
    f.send({ type: 'vad.stop' });
    f.clock.advance(100);
    f.send({ type: 'vad.start' });
    f.clock.advance(9000);
    f.send({ type: 'vad.stop' });
    f.clock.advance(5000);
    return f;
  };

  it('noise that restarts the VAD after the commit holds the turn until it ends, live', () => {
    const f = flapping(LIVE);
    // The words at 3 s; the noise stops at 13.65 s and the commit's silence adds 450 ms.
    expect(f.turns).toMatchObject([{ text: "I'm in a coffee shop.", atMs: 14_100 }]);
  });

  it('now a VAD run that brings no words for noiseMs is the room: ended 2.5 s into it', () => {
    const f = flapping(MAYA);
    // The VAD restarted at 4.65 s; with no new words by 7.15 s, the turn ends on its final.
    expect(f.turns).toMatchObject([{ text: "I'm in a coffee shop.", atMs: 7150, reason: 'noise' }]);
    // 6.95 s sooner; 4.15 s after the caller's words, against 11.1 s.
    expect(14_100 - f.turns[0]!.atMs).toBe(6950);
  });

  it('noise that restarts the VAD over a held final ends it without committing the noise', () => {
    const f = replay(new FakeClock(), MAYA);
    f.commits('I will pay around 2', 350);
    f.send({ type: 'vad.start' });
    f.clock.advance(1000);
    f.interim('I will pay around 2');
    f.clock.advance(500);
    f.send({ type: 'vad.stop' });
    // Committed 450 ms later; the final trails off and is held. The café restarts the VAD.
    f.clock.advance(450 + 350 + 100);
    expect(f.turns).toEqual([]);
    f.send({ type: 'vad.start' });
    f.clock.advance(2499);
    expect(f.turns).toEqual([]);
    f.clock.advance(1 + 700);
    // Scribe was not asked to commit the noise, which can come back as invented words.
    expect(f.forced()).toBe(1);
    expect(f.turns).toMatchObject([{ text: 'I will pay around 2', reason: 'hold' }]);
  });

  it('a caller still talking with interims a second apart is never cut by the room rule', () => {
    const f = replay(new FakeClock(), MAYA);
    const interims = Array.from({ length: 9 }, (_, i) => `one two three four ${'word '.repeat(i)}`);
    f.utter(
      9500,
      'one two three four and so on.',
      350,
      interims.map((t) => t.trim()),
    );
    expect(f.turns.map((t) => t.text)).toEqual(['one two three four and so on.']);
  });
});
