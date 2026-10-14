import { describe, expect, it } from 'vitest';
import { AgentConfig, type Inference, type InferenceRequest } from '@winsendotai/ovo-contracts';
import type { ActivityAnnouncement, InferenceActivity } from '@winsendotai/ovo-plugin-kit';
import { AgentBehavior } from '../../behaviors/src/index.ts';
import { FakeClock } from '../../conformance/src/drivers/fake-clock.ts';
import { StreamingCitationStripper } from '../../plugin-llm-openai/src/web-search.ts';
import { unclearForSearch } from '../../plugin-llm-openai/src/search-voice.ts';
import { driverHarness, sleep } from './turn-harness.ts';

/**
 * Wave 12: Maya call 8cb76efc (2026-10-14 02:54:05–02:58:39 UTC, main b18b24e, Waves 6–10) through
 * the turn driver and the real agent behaviour, with the call's words, partials and timings
 * (/tmp/ovo/call7-events.jsonl; ms from each turn's start or endpoint as noted). The model is
 * scripted as it answered live: a request sent no web search answers a question with the
 * uncertainty line (req_a9ec2859, 1,083 ms; req_63a8d0dc, 1,363 ms; req_f1d69261, 1,708 ms); one
 * sent the search searches about 600 ms in and starts its answer about 4.2 s in (req_c245e75c
 * 4,198 ms, req_32e274e6 4,642 ms). The model's words are the call's; held text the call never
 * logged is marked MODELLED.
 */
const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";
const UNSURE = "I'm not completely sure about that. Want me to look it up?";
const FILLER = { text: 'One moment.', afterMs: 1500 };
const ANNOUNCE: ActivityAnnouncement = {
  line: 'Let me look that up.',
  stillLine: 'Still checking, one moment.',
  stillAfterMs: 2500,
};
const CLIPS = [FILLER.text, ANNOUNCE.line!, ANNOUNCE.stillLine!];
const TTS_MS = 150;
const PLAY_MS = 3000;
const SEARCH_AT_MS = 600;
const SEARCHED_MS = 4200;
const UNSEARCHED_MS = 1100;
const T0 = Date.parse('2026-10-14T02:54:05Z');

const SAID = {
  turn7: 'And a few other lesser known places. What do you think about this itinerary?',
  turn7Reply:
    'Prague and Budapest make a lovely December starting point, and Vienna is an easy classic addition; for a quieter stop, consider Brno or Český Krumlov, keeping in mind that winter can mean shorter opening hours and fewer options at some sights. How many days do you have, and are you aiming for Christmas markets or a more relaxed city-and-culture trip?',
  turn11: 'Jan 12th, 2024.',
  /** Turn 12's finals, cumulative, at ms from its start; its endpoint at 16,075 ms. */
  turn12: [
    [960, 'No, no, so...'],
    [4669, "No, no, so... Um, basically, uh, can you tell me a little bit about Zagreb's hist-"],
    [
      9819,
      "No, no, so... Um, basically, uh, can you tell me a little bit about Zagreb's hist- history, the whole Croatia, how it came into existence, the Balkan regions?",
    ],
    [
      11313,
      "No, no, so... Um, basically, uh, can you tell me a little bit about Zagreb's hist- history, the whole Croatia, how it came into existence, the Balkan regions? And, uh...",
    ],
    [
      12784,
      "No, no, so... Um, basically, uh, can you tell me a little bit about Zagreb's hist- history, the whole Croatia, how it came into existence, the Balkan regions? And, uh... You know, how...",
    ],
    [
      15817,
      "No, no, so... Um, basically, uh, can you tell me a little bit about Zagreb's hist- history, the whole Croatia, how it came into existence, the Balkan regions? And, uh... You know, how... Things that as we go closer to Russia and so on and so forth.",
    ],
  ] as const,
  turn12Stop: 16075,
  /** MODELLED: what the search would have answered. */
  history:
    'Zagreb grew from two medieval towns, Kaptol and Gradec, which joined in 1850. Croatia became independent from Yugoslavia in 1991.',
  turn13: 'No, I, I just did.',
  /** The call's first two sentences; the answer they began is MODELLED. */
  turn13Reply:
    'You’re right, you did. I’m sorry. Zagreb grew from two medieval towns, Kaptol and Gradec, which joined in 1850.',
  /** Turn 15's finals from its start (43.563); its endpoint at 7,704 ms. */
  turn15: [
    [1450, 'On how...'],
    [4684, 'On how... The Balkans came into being and how the split happened.'],
    [
      7434,
      'On how... The Balkans came into being and how the split happened. And what all happened after the war and everything.',
    ],
  ] as const,
  turn15Stop: 7704,
  /** MODELLED: what the search would have answered. */
  balkans:
    'Yugoslavia broke apart in 1991, when Slovenia and Croatia declared independence. The wars that followed ended in 1995.',
  turn16: 'Yeah, please, can you do that?',
  turn16Reply:
    'Croatia’s story is closely tied to Yugoslavia, but the Balkans are a broader region, not one country. Croatia declared independence on the 25th of June 1991; war followed, and fighting there largely ended in 1995, while Bosnia’s war ended with the Dayton agreement that year. I can walk you through the background, the breakup, and the aftermath step by step; would you like to start with how Yugoslavia formed? \uE200cite\uE202turn0search1\uE202turn0search0\uE202turn0search5\uE201',
  turn28Reply:
    'Berlin usually has a huge New Year’s Eve celebration, with music, crowds, and fireworks around the Brandenburg Gate. The party mile runs from the Gate to the Victory Column, entry is free, and the fireworks start at midnight.',
  turn29: 'Yeah.',
  /** MODELLED: more on the Brandenburg Gate party, which the search would have found. */
  turn29Reply:
    'The Brandenburg Gate party opens in the early evening, with live bands and a midnight fireworks show.',
};

interface Scripted {
  ms: number;
  text: string;
  searches?: boolean;
  /** The model's `end_call` after its text (turn 16, see its test). */
  endCall?: boolean;
}
const END = { goodbye: 'Goodbye!', reason: 'The caller has what they asked for.' };

/** The model as it answered live: no search tool, no facts, the uncertainty line. */
function script(request: InferenceRequest, tools: boolean): Scripted {
  const input = request.input;
  if (input === SAID.turn7) return { ms: 3940, text: SAID.turn7Reply, searches: tools };
  if (input === SAID.turn11) return { ms: 1460, text: UNSURE };
  if (input.startsWith('No, no, so'))
    return tools
      ? { ms: SEARCHED_MS, text: SAID.history, searches: true }
      : { ms: UNSEARCHED_MS, text: UNSURE };
  if (input === SAID.turn13) return { ms: 1170, text: SAID.turn13Reply };
  if (input.startsWith('On how'))
    return tools
      ? { ms: SEARCHED_MS, text: SAID.balkans, searches: true }
      : { ms: 1363, text: UNSURE };
  if (input === SAID.turn16)
    return { ms: 4640, text: SAID.turn16Reply, searches: tools, endCall: true };
  if (input === 'Berlin on New Year’s Eve?')
    return { ms: SEARCHED_MS, text: SAID.turn28Reply, searches: tools };
  if (input === SAID.turn29)
    return tools
      ? { ms: SEARCHED_MS, text: SAID.turn29Reply, searches: true }
      : { ms: 1708, text: UNSURE };
  return { ms: 1000, text: 'Sure.' };
}

function replay() {
  const clock = new FakeClock();
  const requests: { input: string; tools: boolean; context: string }[] = [];
  const listeners = new Set<(activity: InferenceActivity) => void>();
  let ids = 0;
  const sends = (request: Omit<InferenceRequest, 'signal'>) =>
    request.providerTools === true ||
    (request.providerTools !== false && !unclearForSearch(request));
  const model: Inference & {
    observeActivity(listener: (activity: InferenceActivity) => void): () => void;
  } = {
    generate: () => Promise.reject(new Error('streamed only')),
    async *stream(request) {
      const tools = sends(request);
      requests.push({ input: request.input, tools, context: request.context });
      const reply = script(request, tools);
      let waited = 0;
      const id = `ws-${++ids}`;
      if (reply.searches) {
        await sleep(clock, SEARCH_AT_MS, request.signal);
        waited = SEARCH_AT_MS;
        if (request.signal.aborted) return;
        const started = {
          phase: 'started' as const,
          tool: 'web_search',
          id,
          atMs: clock.now(),
          signal: request.signal,
          announce: ANNOUNCE,
        };
        for (const listener of listeners) listener(started);
      }
      await sleep(clock, reply.ms - waited, request.signal);
      if (request.signal.aborted) return;
      if (reply.searches)
        for (const listener of listeners)
          listener({
            phase: 'finished',
            tool: 'web_search',
            id,
            atMs: clock.now(),
            signal: request.signal,
            outcome: 'succeeded',
            durationMs: reply.ms - SEARCH_AT_MS,
            results: 5,
          });
      // In deltas of a few characters, as the provider streams them: a citation marker is split.
      const stripper = new StreamingCitationStripper();
      for (const delta of reply.text.match(/.{1,6}/gsu) ?? []) {
        const kept = stripper.push(delta);
        if (kept) yield { kind: 'text-delta', delta: kept };
      }
      const rest = stripper.finish();
      if (rest) yield { kind: 'text-delta', delta: rest };
      if (reply.endCall) yield { kind: 'tool', toolId: 'end_call', input: END };
      yield { kind: 'finish' };
    },
    sendsProviderTools: sends,
    observeActivity(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      language: 'en-IN',
      uncertainty: UNSURE,
      opening: { lines: [GREETING] },
      ending: { llmTool: true },
      reply: { firstPhraseWords: 0 },
    }),
    model,
    { execute: async () => ({ state: 'succeeded' }) as never },
    { workspaceId: 'w-1', sessionId: 's-1', now: () => new Date(T0 + clock.now()) },
  );
  const h = driverHarness(clock, behavior, {
    ttsMs: TTS_MS,
    playMs: PLAY_MS,
    fillerPlayMs: 1000,
    fillers: CLIPS,
  });
  listeners.add((activity) => h.driver.inferenceActivity(activity));
  /** What the caller heard from `from` on: each line and when it started, ms from `from`. */
  const heard = (from: number) =>
    h.audio.filter((line) => line.atMs >= from).map((line) => [line.text, line.atMs - from]);
  /** A caller turn, its finals as stable partials at their ms, then its endpoint. */
  const caller = async (
    turnId: string,
    finals: readonly (readonly [number, string])[],
    stopMs: number,
  ) => {
    const start = clock.now();
    h.turn.started(turnId);
    for (const [atMs, text] of finals) {
      await clock.advanceAsync(start + atMs - clock.now());
      h.driver.decide({ type: 'turn.partial', turnId, text, stable: true });
    }
    await clock.advanceAsync(start + stopMs - clock.now());
    h.turn.stopped(turnId, finals.at(-1)![1], FILLER);
    return clock.now();
  };
  return { clock, h, requests, behavior, heard, caller };
}

type Replay = ReturnType<typeof replay>;

/** A caller turn of one final, stopped 600 ms after it; what was heard in the next `playMs`. */
async function say(r: Replay, turnId: string, words: string, playMs = 30_000) {
  const stopped = await r.caller(turnId, [[0, words]], 600);
  await r.clock.advanceAsync(playMs);
  return r.heard(stopped);
}

/** The call's turns, each heard to its end, in order; turn 7 first after the greeting. */
async function call() {
  const r = replay();
  await r.h.greet();
  const heard: Record<string, (string | number)[][]> = {};
  heard.turn7 = await say(r, 'turn-7', SAID.turn7);
  heard.turn11 = await say(r, 'turn-11', SAID.turn11);
  const turn12 = await r.caller('turn-12', SAID.turn12, SAID.turn12Stop);
  await r.clock.advanceAsync(30_000);
  heard.turn12 = r.heard(turn12);
  heard.turn13 = await say(r, 'turn-13', SAID.turn13);
  const turn15 = await r.caller('turn-15', SAID.turn15, SAID.turn15Stop);
  await r.clock.advanceAsync(30_000);
  heard.turn15 = r.heard(turn15);
  heard.turn16 = await say(r, 'turn-16', SAID.turn16);
  heard.turn28 = await say(r, 'turn-28', 'Berlin on New Year’s Eve?');
  heard.turn29 = await say(r, 'turn-29', SAID.turn29);
  return { r, heard };
}

/** Each line heard and when, ms from the endpoint, before Wave 12 (this replay on b18b24e). */
const BEFORE = {
  turn7: [
    ['Let me look that up.', 0],
    ['Prague and Budapest make a lovely December starting point,', 3490],
    [
      'and Vienna is an easy classic addition; for a quieter stop, consider Brno or Český Krumlov, keeping in mind that winter can mean shorter opening hours and fewer options at some sights.',
      6640,
    ],
    [
      'How many days do you have, and are you aiming for Christmas markets or a more relaxed city-and-culture trip?',
      9790,
    ],
  ],
  turn12: [['Please clarify your question.', 992]],
  turn13: [
    ['You’re right, you did.', 720],
    ['I’m sorry.', 3870],
    ['Want more detail?', 7020],
  ],
  turn16: [
    ['Let me look that up.', 0],
    ['Croatia’s story is closely tied to Yugoslavia,', 4190],
    ['but the Balkans are a broader region, not one country.', 7340],
    [
      'Croatia declared independence on the 25th of June 1991; war followed, and fighting there largely ended in 1995, while Bosnia’s war ended with the Dayton agreement that year.',
      10490,
    ],
    [
      'I can walk you through the background, the breakup, and the aftermath step by step; would you like to start with how Yugoslavia formed?',
      13640,
    ],
    ['citeturn0search1turn0search0turn0search5', 16790],
  ],
  turn29: [['Sorry, could you say that again?', 1258]],
};

describe('call 8cb76efc, replayed through the engine (Wave 12)', () => {
  it('F1 turn 12: a clear question is searched and answered, never "Please clarify"', async () => {
    const { r, heard } = await call();
    expect(heard.turn12).not.toEqual(BEFORE.turn12);
    // The search asked ahead on "…the Balkan regions?" was thrown away when the caller went on;
    // the request on their final words is sent the search again (live: no tool, the
    // uncertainty line, which P10 made the clarification). Its search line plays 342 ms after
    // the endpoint, the answer 4.1 s after it.
    expect(heard.turn12).toEqual([
      ['Let me look that up.', 342],
      ['Zagreb grew from two medieval towns,', 4092],
      ['Kaptol and Gradec, which joined in 1850.', 7242],
      ['Croatia became independent from Yugoslavia in 1991.', 10392],
    ]);
    const asked = r.requests.filter((request) => request.input.startsWith('No, no, so'));
    expect(asked.map((request) => request.tools)).toEqual([false, false, true, false, false, true]);
  });

  it('F1 turn 15: the same, for "…how the split happened. And what all happened after the war"', async () => {
    const { heard } = await call();
    // Before: [["I'm not completely sure about that.", …], ["Want me to look it up?", …]].
    expect(heard.turn15.map(([line]) => line)).toEqual([
      'Let me look that up.',
      'Yugoslavia broke apart in 1991,',
      'when Slovenia and Croatia declared independence.',
      'The wars that followed ended in 1995.',
    ]);
  });

  it('F1 turn 29: a yes to "Would you like more on that?" is looked up, not asked again', async () => {
    const { r, heard } = await call();
    expect(heard.turn28.at(-1)).toEqual(['Want more detail?', 10050]);
    expect(heard.turn29).not.toEqual(BEFORE.turn29);
    expect(heard.turn29).toEqual([
      ['Let me look that up.', 0],
      ['The Brandenburg Gate party opens in the early evening,', 3750],
      ['with live bands and a midnight fireworks show.', 6900],
    ]);
    expect(r.requests.at(-1)).toMatchObject({ input: 'Yeah.', tools: true });
  });

  it('F3 and F7 turn 16: no citation marker, and a refused end_call keeps the cap', async () => {
    const { heard } = await call();
    // Before: every held sentence and the marker ("cite turn zero search one…"), 20 s in all,
    // released by the model's end_call after its text, which the call then refused.
    expect(heard.turn16).not.toEqual(BEFORE.turn16);
    expect(heard.turn16).toEqual([
      ['Let me look that up.', 0],
      ['Croatia’s story is closely tied to Yugoslavia,', 4190],
      ['but the Balkans are a broader region, not one country.', 7340],
      ['Croatia declared independence on the 25th of June 1991.', 10490],
      ['Would you like to start with how Yugoslavia formed?', 13640],
    ]);
    expect(heard.turn16.flat().join(' ')).not.toMatch(/cite|turn0/u);
  });

  it('F5 turn 7: the semicolon ends a sentence, the cap stops there, its own question closes', async () => {
    const { heard } = await call();
    expect(heard.turn7).not.toEqual(BEFORE.turn7);
    // First audio as before (3,490 ms); the 184-character run-on (12 s live, 0.95 s of dead air
    // after its semicolon) is now its first clause, and the reply's own question follows.
    expect(heard.turn7).toEqual([
      ['Let me look that up.', 0],
      ['Prague and Budapest make a lovely December starting point,', 3490],
      ['and Vienna is an easy classic addition.', 6640],
      [
        'How many days do you have, and are you aiming for Christmas markets or a more relaxed city-and-culture trip?',
        9790,
      ],
    ]);
  });

  it('F7 turn 13: two short sentences are not the whole answer', async () => {
    const { heard } = await call();
    expect(heard.turn13).not.toEqual(BEFORE.turn13);
    expect(heard.turn13).toEqual([
      ['You’re right, you did.', 720],
      ['I’m sorry.', 3870],
      ['Zagreb grew from two medieval towns, Kaptol and Gradec, which joined in 1850.', 7020],
    ]);
  });
});
