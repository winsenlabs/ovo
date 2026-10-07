import { describe, expect, it } from 'vitest';
import type { ActivityAnnouncement, InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import type { TurnFiller } from '../src/engine/turn-filler.ts';
import { driverHarness, slowAgent } from './turn-harness.ts';

/**
 * N3, from Maya call bcbc7d6a (2026-10-07), turn 1, times from the caller stopping: the generic
 * filler (then "Let me look that up.") started at 0.7 s; the search held the first sentence until
 * 5.16 s, so after a ~1.3 s filler the caller heard about 3 s of silence. Here the reply comes after
 * 4 s and the provider starts its search 1.2 s in.
 */
const SEARCH_MS = 1200;
const LLM_MS = 4000;
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
/** A neutral generic filler, as N3 asks of agents with web search. */
const NEUTRAL = { text: 'One moment.', afterMs: 1500 };
const CLIPS = [NEUTRAL.text, ANNOUNCE.line!, ANNOUNCE.stillLine!];

const started = (
  signal = new AbortController().signal,
  /** null: a provider tool with nothing to say. */
  announce: ActivityAnnouncement | null = ANNOUNCE,
): InferenceActivity => ({
  phase: 'started',
  tool: 'web_search',
  id: 'ws-1',
  atMs: 0,
  signal,
  ...(announce ? { announce } : {}),
});

function setup(llmMs = LLM_MS) {
  const clock = new FakeClock();
  const agent = slowAgent(clock, { llmMs });
  const h = driverHarness(clock, agent.behavior, { ttsMs: 200, playMs: 1500, fillers: CLIPS });
  // Until the engine subscribes the driver to the inference port's activity (cross-lane wiring),
  // the test hands the activity to the runner's filler as that subscription will.
  const filler = (h.driver as unknown as { filler: TurnFiller }).filler;
  return { clock, agent, h, filler };
}

const timeline = (lines: { text: string; atMs: number }[], t0: number) =>
  lines.map((line) => [line.text, line.atMs - t0]);

describe('a search turn says what it is doing (N3)', () => {
  it('plays the search line when the search starts and "still checking" 2.5 s later', async () => {
    const { clock, h, filler } = setup();
    const t0 = await h.greet();
    h.caller('what is the weather in Zagreb in December', NEUTRAL);
    await clock.advanceAsync(SEARCH_MS);
    filler.activity(started());
    await clock.advanceAsync(10_000);
    expect(timeline(h.audio, t0)).toEqual([
      [ANNOUNCE.line, SEARCH_MS],
      [ANNOUNCE.stillLine, SEARCH_MS + ANNOUNCE.stillAfterMs],
      ['Answer: what is the weather in Zagreb in December.', LLM_MS + 200],
    ]);
    // The answer cuts "still checking" the moment its first line is ready (P3).
    expect(timeline(h.cut, t0)).toEqual([[ANNOUNCE.stillLine, LLM_MS]]);
    // Live the caller sat through ~3 s of silence after the filler; now no gap passes 1 s.
    const ends = h.audio.map(
      (line) => h.cut.find((cut) => cut.text === line.text)?.atMs ?? line.atMs + 1500,
    );
    const gaps = h.audio.slice(1).map((line, index) => line.atMs - ends[index]!);
    expect(gaps).toEqual([1000, 200]);
  });

  it('never plays the search line on a turn that does not search', async () => {
    const { clock, h } = setup(2500);
    const t0 = await h.greet();
    h.caller('three days I think', NEUTRAL);
    await clock.advanceAsync(10_000);
    expect(timeline(h.audio, t0)).toEqual([
      [NEUTRAL.text, NEUTRAL.afterMs],
      ['Answer: three days I think.', 2700],
    ]);
  });

  it('follows a generic filler that already started, once', async () => {
    const { clock, h, filler } = setup();
    const t0 = await h.greet();
    h.caller('is there vegetarian food', { text: NEUTRAL.text, afterMs: 700 });
    await clock.advanceAsync(SEARCH_MS);
    filler.activity(started());
    filler.activity({ ...started(), id: 'ws-2' });
    await clock.advanceAsync(10_000);
    expect(timeline(h.audio, t0).slice(0, 2)).toEqual([
      [NEUTRAL.text, 700],
      [ANNOUNCE.line, 700 + 1500],
    ]);
    expect(h.audio.filter((line) => line.text === ANNOUNCE.line)).toHaveLength(1);
  });

  it('says nothing for a search the turn abandoned, an unannounced one, or over the caller', async () => {
    const aborted = setup();
    let t0 = await aborted.h.greet();
    aborted.h.caller('what about Rome');
    await aborted.clock.advanceAsync(SEARCH_MS);
    const gone = new AbortController();
    gone.abort();
    aborted.filler.activity(started(gone.signal));
    aborted.filler.activity(started(undefined, null));
    await aborted.clock.advanceAsync(10_000);
    expect(timeline(aborted.h.audio, t0)).toEqual([['Answer: what about Rome.', LLM_MS + 200]]);

    const speaking = setup();
    t0 = await speaking.h.greet();
    speaking.h.caller('what about Rome');
    await speaking.clock.advanceAsync(SEARCH_MS);
    speaking.h.scheduler.hold();
    speaking.filler.activity(started());
    await speaking.clock.advanceAsync(1000);
    speaking.h.scheduler.release();
    await speaking.clock.advanceAsync(10_000);
    expect(speaking.h.audio.map((line) => line.text)).not.toContain(ANNOUNCE.line);
  });

  it('says nothing once the reply has started', async () => {
    const { clock, h, filler } = setup(800);
    const t0 = await h.greet();
    h.caller('and the museums');
    await clock.advanceAsync(SEARCH_MS);
    filler.activity(started());
    await clock.advanceAsync(10_000);
    expect(timeline(h.audio, t0)).toEqual([['Answer: and the museums.', 1000]]);
  });
});
