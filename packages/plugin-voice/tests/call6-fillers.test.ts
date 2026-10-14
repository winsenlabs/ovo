import { describe, expect, it } from 'vitest';
import {
  SAID_BEFORE_REPLY_VARIABLE,
  type Behavior,
  type TurnSpeculation,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep } from '../../eval/src/replay-kit/index.ts';

/**
 * Wave 10, L3: Maya call 4f1a919d (2026-10-13). "One moment." played 1.5 s into turns 8, 11 and 12
 * and was cut 0.88, 0.21 and 0.08 s in by replies of four to eight words that could not search.
 * A reply whose model request went without the search tool (`Behavior.lookingUp` false) and whose
 * words want a few words back plays no filler; a goodbye or a closing never does. Times are ms
 * from the turn's endpoint decision; TTS first byte 150 ms, the filler a clip.
 */
const FILLER = { text: 'One moment.', afterMs: 1500 };
const TTS_MS = 150;

/** A behaviour whose model takes `llmMs` and was sent the search tool when `search` says so. */
function agent(clock: FakeClock, llmMs: number, search: (input: string) => boolean | undefined) {
  let lookingUp: boolean | undefined;
  const behavior: Behavior & TurnSpeculation = {
    respond: async () => '',
    async *respondStream(input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hi, this is Maya.';
        return;
      }
      lookingUp = search(input);
      await sleep(clock, llmMs);
      yield `Answer: ${input}`;
    },
    beginTurn: () => {
      lookingUp = undefined;
    },
    lookingUp: () => lookingUp,
  };
  return behavior;
}

async function heard(
  words: string,
  { llmMs = 1700, search = (() => false) as (input: string) => boolean | undefined },
) {
  const clock = new FakeClock();
  const h = driverHarness(clock, agent(clock, llmMs, search), {
    ttsMs: TTS_MS,
    playMs: 2000,
    fillerPlayMs: 1000,
    fillers: [FILLER.text],
  });
  const t0 = await h.greet();
  h.driver.decide({
    type: 'turn.stopped',
    turnId: 'turn-1',
    input: { kind: 'speech', text: words, segments: 1 },
    filler: FILLER,
  });
  await clock.advanceAsync(5000);
  return h.audio.map((line) => [line.text, line.atMs - t0]);
}

describe('call 4f1a919d L3: no filler before a reply of a few words that cannot search', () => {
  it('turn 12 ("Yeah, yeah.", 1,577 ms): no "One moment." cut 0.08 s in', async () => {
    // Before: [["One moment.", 1500], ["Answer: Yeah, yeah.", 1727]].
    expect(await heard('Yeah, yeah.', { llmMs: 1577 })).toEqual([['Answer: Yeah, yeah.', 1727]]);
  });

  it('turn 11 ("No, okay, I’ll take it later. Thank you so much."): none, though sent the search', async () => {
    expect(
      await heard("No, okay, I'll take it later. Thank you so much.", {
        llmMs: 1709,
        search: () => true,
      }),
    ).toEqual([["Answer: No, okay, I'll take it later. Thank you so much.", 1859]]);
  });

  it('keeps the filler for a yes that may search, a question, or an unknown request', async () => {
    // Call-3 turn 21: "Yeah." accepted an offer to look something up, and searched.
    expect(await heard('Yeah.', { search: () => true })).toEqual([
      [FILLER.text, 1500],
      ['Answer: Yeah.', 1850],
    ]);
    expect(await heard('What are ruin bars?', {})).toEqual([
      [FILLER.text, 1500],
      ['Answer: What are ruin bars?', 1850],
    ]);
    expect(await heard('Okay.', { search: () => undefined })).toEqual([
      [FILLER.text, 1500],
      ['Answer: Okay.', 1850],
    ]);
  });
});

describe('call 4f1a919d B1 and L3: words queued behind a reply the caller had not heard', () => {
  it('turn 8: "Madras." carries the earlier words, and plays no filler', async () => {
    const clock = new FakeClock();
    const h = driverHarness(
      clock,
      agent(clock, 2373, () => false),
      {
        ttsMs: TTS_MS,
        playMs: 2000,
        fillerPlayMs: 1000,
        fillers: [FILLER.text],
      },
    );
    const seen: Record<string, unknown>[] = [];
    const behavior = h.driver['behavior'] as Behavior;
    const respond = behavior.respondStream!.bind(behavior);
    behavior.respondStream = (input, variables = {}) => {
      if (!variables.inputEvent) seen.push({ input, ...variables });
      return respond(input, variables);
    };
    const t0 = await h.greet();
    h.turn.stopped('turn-7', 'Chennai, Chennai.', FILLER);
    await clock.advanceAsync(1022);
    // Turn 7 searched: brief words do not start it over (call-3 #1).
    h.driver.inferenceActivity({
      phase: 'started',
      tool: 'web_search',
      id: 'ws-1',
      atMs: clock.now(),
      signal: new AbortController().signal,
    });
    h.turn.stopped('turn-8', 'Madras.', FILLER);
    await clock.advanceAsync(10_000);
    expect(seen.map((turn) => [turn.input, turn[SAID_BEFORE_REPLY_VARIABLE]])).toEqual([
      ['Chennai, Chennai.', undefined],
      ['Madras.', 'Chennai, Chennai.'],
    ]);
    const answered = 2373 + TTS_MS + 2000;
    // Before: "One moment." 1.5 s into turn 8 as well.
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      [FILLER.text, 1500],
      ['Answer: Chennai, Chennai.', 2373 + TTS_MS],
      ['Answer: Madras.', answered + 2373 + TTS_MS],
    ]);
  });

  it('words said once the reply was heard carry nothing', async () => {
    const clock = new FakeClock();
    const h = driverHarness(
      clock,
      agent(clock, 500, () => false),
      { ttsMs: TTS_MS, playMs: 2000 },
    );
    const seen: Record<string, unknown>[] = [];
    const behavior = h.driver['behavior'] as Behavior;
    const respond = behavior.respondStream!.bind(behavior);
    behavior.respondStream = (input, variables = {}) => {
      if (!variables.inputEvent) seen.push({ ...variables });
      return respond(input, variables);
    };
    await h.greet();
    h.turn.stopped('turn-7', 'Chennai, Chennai.');
    await clock.advanceAsync(1000);
    h.turn.stopped('turn-8', 'Madras.');
    await clock.advanceAsync(10_000);
    expect(seen.map((variables) => variables[SAID_BEFORE_REPLY_VARIABLE])).toEqual([
      undefined,
      undefined,
    ]);
  });
});
