import { describe, expect, it } from 'vitest';
import {
  statesPlans,
  type Behavior,
  type EndpointRule,
  type TurnSpeculation,
} from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement, InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { driverHarness, sleep, slowAgent } from './turn-harness.ts';

/**
 * Wave 8b: Maya call e8a43f65 (2026-10-12) through the turn driver. The caller turns are the turn
 * detector's for the call with Maya's row (plugin-turns tests/call4-replay.test.ts: the same
 * transcripts, interims and VAD runs, ms from 11:06:00), the "Germany, Berlin…" utterance 600 ms
 * after "Prague." (modelled). The LLM's first token comes 1444 ms into a reply (the call's turn 4,
 * which did not search); a searched reply starts its search 1 s in and answers at 4034 ms (turn 6).
 * TTS first byte 150 ms (the call's 137–159), a pre-rendered filler clip plays 800 ms.
 */
const SAID = {
  turn1: '"We\'re planning to go to Zagreb this..." No, December.',
  turn2: 'I want 21st of December to the 5th.',
  turn3: 'Of January.',
  turn4: "Yeah, we're planning to do Budapest, Vienna,",
  turn5: "in Austria. Then we're planning to go to Zagreb, Prague.",
  turn6: 'Germany, Berlin, and a few other places.',
  turn7: "Ma'am, create a call.",
};
const LIST = `${SAID.turn4} ${SAID.turn5}`;
const FILLER = { text: 'One moment.', afterMs: 1500 };
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
const CLIPS = [FILLER.text, ANNOUNCE.line!, ANNOUNCE.stillLine!];
const FIRST_TOKEN_MS = 1444;
const SEARCH_AT_MS = 1000;
const SEARCH_ANSWER_MS = 4034;
const TTS_MS = 150;

type Step =
  | { at: number; vad: 'vad.start' | 'vad.stop' }
  | { at: number; started: string }
  | { at: number; partial: string; words: string }
  | { at: number; stopped: string; words: string; reason: EndpointRule };

/** The call's caller turns, as the detector decided them (see above). */
const CALL: Step[] = [
  { at: 18_400, vad: 'vad.start' },
  { at: 18_400, started: 'turn-1' },
  { at: 19_400, partial: 'turn-1', words: "We're planning to go" },
  { at: 21_400, partial: 'turn-1', words: SAID.turn1 },
  { at: 22_177, vad: 'vad.stop' },
  { at: 22_569, stopped: 'turn-1', words: SAID.turn1, reason: 'complete' },
  { at: 39_400, vad: 'vad.start' },
  { at: 39_400, started: 'turn-2' },
  { at: 40_400, partial: 'turn-2', words: 'I want 21st' },
  { at: 41_400, partial: 'turn-2', words: SAID.turn2 },
  { at: 41_917, vad: 'vad.stop' },
  // The date range awaits its month: the detector held the turn 700 ms (`hold`).
  { at: 42_872, stopped: 'turn-2', words: SAID.turn2, reason: 'hold' },
  // "Of January.", said softly (no VAD run) 1.3 s later, ends like a short answer.
  { at: 44_178, started: 'turn-3' },
  { at: 44_178, partial: 'turn-3', words: SAID.turn3 },
  { at: 44_725, stopped: 'turn-3', words: SAID.turn3, reason: 'answer' },
  { at: 64_000, vad: 'vad.start' },
  { at: 64_000, started: 'turn-4' },
  { at: 65_000, partial: 'turn-4', words: "Yeah, we're planning" },
  { at: 66_900, partial: 'turn-4', words: SAID.turn4 },
  { at: 67_077, vad: 'vad.stop' },
  // The trailing comma held the turn; the caller went on 0.88 s later, in the same turn.
  { at: 67_958, vad: 'vad.start' },
  { at: 68_958, partial: 'turn-4', words: `${SAID.turn4} in Austria.` },
  { at: 71_657, partial: 'turn-4', words: LIST },
  { at: 71_857, vad: 'vad.stop' },
  { at: 72_240, stopped: 'turn-4', words: LIST, reason: 'complete' },
  { at: 72_457, vad: 'vad.start' },
  { at: 72_457, started: 'turn-5' },
  { at: 73_357, partial: 'turn-5', words: 'Germany, Berlin,' },
  { at: 74_500, partial: 'turn-5', words: SAID.turn6 },
  { at: 74_777, vad: 'vad.stop' },
  { at: 75_189, stopped: 'turn-5', words: SAID.turn6, reason: 'complete' },
  { at: 89_900, vad: 'vad.start' },
  { at: 89_900, started: 'turn-6' },
  { at: 90_900, partial: 'turn-6', words: SAID.turn7 },
  { at: 91_457, vad: 'vad.stop' },
  { at: 91_793, stopped: 'turn-6', words: SAID.turn7, reason: 'complete' },
];

interface Model {
  /** Whether the reply to `input` searches (the OpenAI plugin's search guard decides it). */
  searches: (input: string) => boolean;
  /** When the reply's first token comes, from its start. */
  firstTokenMs?: (input: string) => number;
}

/** Maya as the engine sees her: a streamed LLM reply, its web search reported as it starts. */
function maya(clock: FakeClock, model: Model) {
  const asked: [string, number][] = [];
  const cancelled: number[] = [];
  /** Each search: the words it was for, when it started and when it stopped (answer or abort). */
  const searches: { input: string; from: number; to?: number }[] = [];
  const target: { driver?: { inferenceActivity(activity: InferenceActivity): void } } = {};
  let turn = new AbortController();
  const behavior: Behavior & TurnSpeculation = {
    respond: async () => '',
    async *respondStream(input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";
        return;
      }
      const { signal } = turn;
      asked.push([input, clock.now()]);
      if (model.searches(input)) {
        await sleep(clock, SEARCH_AT_MS, signal);
        if (signal.aborted) return;
        const search = { input, from: clock.now() } as (typeof searches)[number];
        searches.push(search);
        signal.addEventListener('abort', () => (search.to ??= clock.now()), { once: true });
        target.driver!.inferenceActivity({
          phase: 'started',
          tool: 'web_search',
          id: `ws-${searches.length}`,
          atMs: clock.now(),
          signal,
          announce: ANNOUNCE,
        });
        await sleep(clock, SEARCH_ANSWER_MS - SEARCH_AT_MS, signal);
        search.to ??= clock.now();
      } else await sleep(clock, model.firstTokenMs?.(input) ?? FIRST_TOKEN_MS, signal);
      if (signal.aborted) return;
      yield `Answer: ${input}`;
    },
    cancel: () => {
      cancelled.push(clock.now());
      turn.abort();
      turn = new AbortController();
    },
  };
  return { behavior, asked, cancelled, searches, target };
}

async function replay(model: Model) {
  const clock = new FakeClock();
  const agent = maya(clock, model);
  const h = driverHarness(clock, agent.behavior, {
    ttsMs: TTS_MS,
    playMs: 3000,
    fillerPlayMs: 800,
    fillers: CLIPS,
  });
  agent.target.driver = h.driver;
  await h.greet();
  for (const step of CALL) {
    await clock.advanceAsync(Math.max(0, step.at - clock.now()));
    if ('vad' in step) h.turn.vad(step.vad);
    else if ('started' in step) h.turn.started(step.started);
    else if ('partial' in step) h.turn.partial(step.partial, step.words);
    else
      h.driver.decide({
        type: 'turn.stopped',
        turnId: step.stopped,
        input: { kind: 'speech', text: step.words, segments: 1 },
        filler: FILLER,
        reason: step.reason,
      });
  }
  await clock.advanceAsync(20_000);
  const heard = h.audio.map((line) => [line.text, line.atMs] as const);
  return { ...agent, heard, ended: h.ended };
}

/** What the agent said between `from` and `to` (call ms), fillers included. */
const between = (heard: readonly (readonly [string, number])[], from: number, to: number) =>
  heard.filter(([, at]) => at > from && at < to).map(([text]) => text);

describe('call e8a43f65 issues 1–4 and 7 through the turn driver', () => {
  // Issue 3: the OpenAI plugin sends the search tool only to words that ask for something
  // (plugin-llm-openai tests/search-guard-call4.test.ts): none of this call's statements search.
  const statements: Model = { searches: (input) => !statesPlans(input) && input !== SAID.turn7 };

  it('answers the dates and the cities once each, whole, never mid-list', async () => {
    const r = await replay(statements);
    expect(r.asked).toEqual([
      [SAID.turn1, 22_569],
      // Issue 4: each reply superseded by words carrying it on is given up at their first
      // words (44.178 s, 73.357 s), not 0.5–1.8 s later when they end.
      [SAID.turn2, 42_872],
      [`${SAID.turn2} ${SAID.turn3}`, 44_725],
      [LIST, 72_240],
      [`${LIST} ${SAID.turn6}`, 75_189],
      [SAID.turn7, 91_793],
    ]);
    expect(r.cancelled).toEqual([44_178, 73_357]);
    expect(r.searches).toEqual([]);
    // Issues 1 and 2: nothing is said between the caller's dates, nor while they list cities.
    expect(between(r.heard, 39_400, 44_725)).toEqual([]);
    expect(between(r.heard, 64_000, 75_189)).toEqual([]);
    // Issue 7: each answer 1.59 s after its turn ends, no filler (endpoints in call4-replay).
    expect(r.heard).toEqual([
      [`Answer: ${SAID.turn1}`, 22_569 + FIRST_TOKEN_MS + TTS_MS],
      [`Answer: ${SAID.turn2} ${SAID.turn3}`, 44_725 + FIRST_TOKEN_MS + TTS_MS],
      [`Answer: ${LIST} ${SAID.turn6}`, 75_189 + FIRST_TOKEN_MS + TTS_MS],
      [`Answer: ${SAID.turn7}`, 91_793 + FIRST_TOKEN_MS + TTS_MS],
    ]);
  });

  it('holds an answer to dates still awaiting their month for the caller to go on', async () => {
    // Asked on the partial "…to the 5th." (Wave 8 speculation), the LLM has the answer 300 ms
    // after the turn ends: live it would have played at 43.3 s, over "Of January." at 44.2 s.
    const r = await replay({
      ...statements,
      firstTokenMs: (input) => (input === SAID.turn2 ? 300 : FIRST_TOKEN_MS),
    });
    expect(between(r.heard, 39_400, 44_725)).toEqual([]);
    expect(r.asked.map(([input]) => input).slice(1, 3)).toEqual([
      SAID.turn2,
      `${SAID.turn2} ${SAID.turn3}`,
    ]);
    expect(r.heard[1]).toEqual([
      `Answer: ${SAID.turn2} ${SAID.turn3}`,
      44_725 + FIRST_TOKEN_MS + TTS_MS,
    ]);
  });

  it('a reply searching for words the caller carries on stops its search at their first words', async () => {
    // An agent whose binding sends every turn the search tool (`skipUnclearInput: false`), as
    // live: turns 2 and 5 then searched for 2.4 s and 1.9 s after being superseded.
    const r = await replay({ searches: (input) => input !== SAID.turn7 });
    const wasted = r.searches
      .filter(({ input }) => input === SAID.turn2 || input === LIST)
      .map(({ input, from, to }) => [input, from, to! - from]);
    expect(wasted).toEqual([
      [SAID.turn2, 43_872, 306],
      [LIST, 73_240, 117],
    ]);
    // Their search lines were never said: the caller was speaking or about to go on.
    expect(between(r.heard, 39_400, 44_725)).toEqual([]);
    expect(between(r.heard, 64_000, 75_189)).toEqual([]);
  });
});

/**
 * Issue 5, the turns that searched live: the search started (turn 1: modelled, its line was queued
 * behind the filler at 2428 ms; turns 3 and 6: when their search line played) and the first token
 * came (llmFirstTokenMs), ms from each reply's start. Live the caller heard two filler lines on
 * each: "One moment. Let me look that up." and "Let me look that up. Still checking, one moment."
 */
describe('call e8a43f65 issue 5: Wave 8 says one filler line per searched turn', () => {
  it.each([
    ['turn 1', SAID.turn1, 2280, 4607, [[FILLER.text, 1500]]],
    ['turn 3', SAID.turn3, 1236, 3862, [[ANNOUNCE.line, 1236]]],
    ['turn 6', SAID.turn6, 1022, 4034, [[ANNOUNCE.line, 1022]]],
  ] as const)('%s', async (_, words, searchAt, answerAt, fillers) => {
    const clock = new FakeClock();
    const agent = slowAgent(clock, { llmMs: answerAt });
    const h = driverHarness(clock, agent.behavior, {
      ttsMs: TTS_MS,
      playMs: 3000,
      fillerPlayMs: 800,
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
    // "Still checking" waits 2.5 s of silence after the line, so the answer comes first.
    expect(h.audio.map((line) => [line.text, line.atMs - t0])).toEqual([
      ...fillers,
      [`Answer: ${words}.`, answerAt + TTS_MS],
    ]);
  });
});
