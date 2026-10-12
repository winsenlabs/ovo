import { describe, expect, it } from 'vitest';
import type { Behavior } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, slowAgent } from './turn-harness.ts';

/**
 * Wave 9, issue D6: Maya call 10d5ef30 (2026-10-12). Turn 22's reply was ready 1.68 s after the
 * turn ended; its 1.5 s filler ("One moment.") played for 180 ms and was cut. A reply whose first
 * words are in by then (`Behavior.drafting`) is a few hundred ms from its first line: no filler.
 */
const FILLER = { text: 'One moment.', afterMs: 1500 };
const TTS_MS = 150;

/** A reply ready at `readyMs`, its first words in at `wordsMs`. */
function run(readyMs: number, wordsMs: number) {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs: readyMs });
  let askedAt: number | undefined;
  const behavior: typeof agent.behavior & Pick<Behavior, 'drafting'> = {
    ...agent.behavior,
    async *respondStream(input, variables = {}) {
      if (variables.inputEvent !== 'opening') askedAt = clock.now();
      yield* agent.behavior.respondStream!(input, variables);
    },
    drafting: () => askedAt !== undefined && clock.now() - askedAt >= wordsMs,
  };
  const h = driverHarness(clock, behavior, {
    ttsMs: TTS_MS,
    playMs: 1000,
    fillerPlayMs: 800,
    fillers: [FILLER.text],
  });
  return { clock, h };
}

describe('call 10d5ef30 D6: no filler before a reply that is nearly ready', () => {
  it('a reply ready at 1.6 s, its first words in at 1.3 s, plays with no filler', async () => {
    const { clock, h } = run(1600, 1300);
    const t0 = await h.greet();
    h.caller('Never mind. Thank you so much for the ideas.', FILLER);
    await clock.advanceAsync(10_000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ['Answer: Never mind. Thank you so much for the ideas..', 1600 + TTS_MS],
    ]);
  });

  it('a reply whose words are not in by the filler’s time still gets it', async () => {
    const { clock, h } = run(2600, 2300);
    const t0 = await h.greet();
    h.caller('What about Vienna?', FILLER);
    await clock.advanceAsync(10_000);
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      [FILLER.text, 1500],
      ['Answer: What about Vienna?.', 2600 + TTS_MS],
    ]);
  });
});
