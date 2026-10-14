import { describe, expect, it } from 'vitest';
import type { ActivityAnnouncement } from '@winsendotai/ovo-plugin-kit';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, slowAgent } from '../../eval/src/replay-kit/index.ts';

/**
 * Wave 9, issue D6: Maya call 10d5ef30 (2026-10-12, main 519966b), ms from each turn's stop, when
 * its 1.5 s filler timer starts. Turn 13 heard "One moment." at 1.5 s and "Still checking, one
 * moment." at 5.01 s, cut by the answer 0.24 s later (5.25 s); turn 17 ("Yeah, that's what I said,
 * right?") heard "Let me look that up." when its search started (1.04 s) and "Still checking, one
 * moment." at 5.01 s, cut by the answer 0.05 s later (5.06 s). Turn 13's search start is modelled
 * (after its filler, which it would otherwise have replaced); the rest is measured.
 */
const FILLER = { text: 'One moment.', afterMs: 1500 };
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
const CLIPS = [FILLER.text, ANNOUNCE.line!, ANNOUNCE.stillLine!];
const TTS_MS = 150;

async function turn(words: string, searchAt: number, answerAt: number) {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs: answerAt });
  const h = driverHarness(clock, agent.behavior, {
    ttsMs: TTS_MS,
    playMs: 3000,
    fillerPlayMs: 1000,
    fillers: CLIPS,
  });
  const t0 = await h.greet();
  h.caller(words, FILLER);
  await clock.advanceAsync(searchAt);
  h.driver.inferenceActivity({
    phase: 'started',
    tool: 'web_search',
    id: 'ws-1',
    atMs: clock.now(),
    signal: new AbortController().signal,
    announce: ANNOUNCE,
  });
  await clock.advanceAsync(10_000);
  return h.audio.map((line) => [line.text, line.atMs - t0]);
}

describe('call 10d5ef30 D6: one filler line per turn, the progress line included', () => {
  it('turn 13: "One moment." and then the answer, no "Still checking"', async () => {
    const words = 'What about Northern Lights and stuff like that?';
    expect(await turn(words, 1800, 5250)).toEqual([
      [FILLER.text, 1500],
      [`Answer: ${words}.`, 5250 + TTS_MS],
    ]);
  });

  it('turn 17: "Let me look that up." and then the answer, no "Still checking"', async () => {
    const words = "Yeah, that's what I said, right?";
    expect(await turn(words, 1040, 5060)).toEqual([
      [ANNOUNCE.line, 1040],
      [`Answer: ${words}.`, 5060 + TTS_MS],
    ]);
  });
});
