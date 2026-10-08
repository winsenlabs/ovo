import { describe, expect, it } from 'vitest';
import type { Behavior, TurnDecision, TurnSpeculation } from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { IDLE_AFTER_ANSWER } from '../src/engine/idle-pacing.ts';
import { driverHarness, sleep } from './turn-harness.ts';

/**
 * Call 6e1a4e3a, turn 18 (2026-10-08 08:03:59): the agent's answer, said twice over (~460
 * characters, ~30 s), ended about 08:04:20, and the turn detector's "Are you still there?" (its
 * default 10 s idle) came at 08:04:30, while the caller was still taking it in.
 */
const TURN_18 =
  'Just to confirm, you mean December 20, 2026, returning January 1, 2027, right? I can confirm Lufthansa operates nonstop service on this route, but I can’t verify live seat availability or the fare for those exact dates. Just to confirm, you mean December 20, 2026, returning January 1, 2027, right? I can confirm Lufthansa operates nonstop service on this route, but I can’t verify live seat availability or fares for those exact dates.';
const SHORT = 'What day would you like to leave?';
const DETECTOR_IDLE_MS = 10_000;
const PROMPT = 'Are you still there?';
const PLAY_MS = 2000;

function agent(clock: FakeClock, answer: string, idleTimeoutMs?: number) {
  const behavior: Behavior & TurnSpeculation & { idleTimeoutMs?(): number } = {
    respond: async () => '',
    async *respondStream(_input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hi.';
        return;
      }
      if (variables.inputEvent === 'idle') {
        yield PROMPT;
        return;
      }
      await sleep(clock, 500);
      yield answer;
    },
    ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs: () => idleTimeoutMs }),
  };
  return behavior;
}

/**
 * The caller asks, the answer plays (`PLAY_MS` per line), and the turn detector, as its default
 * idle does, reports silence `DETECTOR_IDLE_MS` after the agent stopped. Returns when each prompt
 * was said, from the end of the answer's playback.
 */
async function detectorSilence(answer: string, during?: (h: Harness) => void) {
  const clock = new FakeClock();
  const h = driverHarness(clock, agent(clock, answer), { ttsMs: 100, playMs: PLAY_MS });
  await h.greet();
  h.caller('So we would like to leave on the 20th and be back around the 1st.');
  await clock.advanceAsync(500 + 100 + PLAY_MS);
  const endedAt = clock.now();
  h.audio.length = 0;
  const idle = (retry: number, final: boolean): TurnDecision => ({
    type: 'idle',
    retry,
    final,
    ...(final ? {} : { prompt: PROMPT }),
  });
  await clock.advanceAsync(DETECTOR_IDLE_MS);
  h.driver.decide(idle(1, false));
  await clock.advanceAsync(1000);
  during?.(h);
  await clock.advanceAsync(15_000);
  return { h, clock, endedAt, idle, prompts: h.audio.map((line) => line.atMs - endedAt - 100) };
}
type Harness = ReturnType<typeof driverHarness>;

describe('call-3 #8: an idle prompt waits longer after a long answer', () => {
  it('turn 18: "Are you still there?" comes 10 s later than live after a 460-character answer', async () => {
    const { prompts } = await detectorSilence(TURN_18);
    // Live (and still after a short answer): 10 s after the answer ended.
    expect(IDLE_AFTER_ANSWER.maxExtraMs).toBe(10_000);
    expect(prompts).toEqual([DETECTOR_IDLE_MS + 10_000]);
  });

  it('leaves the prompt after a short answer or a question where it was', async () => {
    const { prompts } = await detectorSilence(SHORT);
    expect(prompts).toEqual([DETECTOR_IDLE_MS]);
  });

  it('scales with the answer: 40 ms a character past the first 60', async () => {
    const answer = 'x'.repeat(160) + '.';
    const { prompts } = await detectorSilence(answer);
    expect(prompts).toEqual([DETECTOR_IDLE_MS + (161 - 60) * 40]);
  });

  it('drops the prompt when the caller is heard in the extra silence, and still says it once', async () => {
    const { h, clock, endedAt, idle } = await detectorSilence(TURN_18, (harness) =>
      harness.turn.vad('vad.start'),
    );
    expect(h.audio).toEqual([]);
    // The detector's next silence is its final one: the prompt it never said comes first.
    h.driver.decide(idle(1, true));
    await clock.advanceAsync(5000);
    expect(h.audio.map((line) => line.text)).toEqual([PROMPT]);
    expect(h.ended).toEqual([]);
    h.driver.decide(idle(1, true));
    expect(h.ended).toEqual(['caller_idle']);
    expect(clock.now() - endedAt).toBeGreaterThan(DETECTOR_IDLE_MS);
  });

  it('never prompts while the answer is still playing', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, agent(clock, SHORT), { ttsMs: 100, playMs: 30_000 });
    await h.greet();
    h.caller('and the dates?');
    await clock.advanceAsync(2000);
    // An early bot.stopped (a line reported done before it was) armed the detector.
    h.driver.decide({ type: 'idle', retry: 1, final: false, prompt: PROMPT });
    await clock.advanceAsync(5000);
    expect(h.audio.map((line) => line.text)).toEqual([SHORT]);
  });
});

describe("call-3 #8: a behaviour's own idle policy (AGT-11)", () => {
  it('times its silence from the end of the answer, plus the extra silence', async () => {
    const clock = new FakeClock();
    const h = driverHarness(clock, agent(clock, TURN_18, 8000), { ttsMs: 100, playMs: PLAY_MS });
    await h.greet();
    h.caller('So we would like to leave on the 20th.');
    await clock.advanceAsync(500 + 100 + PLAY_MS);
    const endedAt = clock.now();
    await clock.advanceAsync(30_000);
    const prompt = h.audio.find((line) => line.text === PROMPT);
    expect(prompt!.atMs - endedAt).toBe(8000 + 10_000 + 100);
  });
});
