import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Inference, InferenceRequest } from '@winsendotai/ovo-contracts';
import { DEFAULT_SPECULATION, type LlmSpeculationMetrics } from '../src/index.ts';
import type { InferenceCall } from '../src/speculation-llm.ts';
import { PartialLlmSpeculation } from '../src/speculation-partial.ts';
import { sleep } from './speculation-fixture.ts';

/** One live call as `fixtures/llm-speculation-live-calls.json` keeps it. */
type LiveEvent =
  | { t: number; k: 'interim'; text: string }
  | { t: number; k: 'final'; text: string }
  | { t: number; k: 'stopped'; text: string }
  | { t: number; k: 'said'; seg: string }
  | { t: number; k: 'played'; seg: string }
  | { t: number; k: 'started' }
  | { t: number; k: 'interrupt' };

const LIVE = JSON.parse(
  readFileSync(new URL('./fixtures/llm-speculation-live-calls.json', import.meta.url), 'utf8'),
) as { calls: { call: string; events: LiveEvent[] }[] };

/**
 * gpt-6-luna's first token on a turn that does not search, in Maya call f3363705 (2026-10-07,
 * latency-evidence D: 1242, 1367 and 1660 ms; median 1367). A searched turn waits longer, so the
 * saving below, capped at this, is a floor for it.
 */
const FIRST_TOKEN_MS = 1_367;

function slowLlm(sendsProviderTools?: Inference['sendsProviderTools']) {
  const asked: InferenceRequest[] = [];
  const port: Inference = {
    ...(sendsProviderTools ? { sendsProviderTools } : {}),
    generate: () => Promise.reject(new Error('streamed only')),
    async *stream(request) {
      asked.push(request);
      await sleep(FIRST_TOKEN_MS, request.signal);
      yield { kind: 'text-delta', delta: 'An answer.' };
      yield { kind: 'finish' };
    },
  };
  return { port, asked };
}

/**
 * Replays a live call's transcript through the LLM speculation, as the turn driver hands it over
 * (`turn.partial` per revision, `finalize` and then the turn when it stops, `cancel` on barge-in).
 * What the request depends on moves when a turn commits and when an agent line ends; while a line
 * is playing, the agent is speaking and nothing is asked. Returns, per caller turn, how much
 * sooner its first token arrived than asking at the end of the turn.
 */
async function replay(events: readonly LiveEvent[], speculate: boolean, port?: SearchPort) {
  const llm = slowLlm(port);
  const metrics: LlmSpeculationMetrics = {
    started: 0,
    used: 0,
    aborted: 0,
    discarded: 0,
    onPartials: 0,
  };
  const speculation = new PartialLlmSpeculation(DEFAULT_SPECULATION, llm.port, metrics);
  let state = 0;
  const speaking = new Set<string>();
  let utterance = 0;
  let finals: string[] = [];
  let interim: string | undefined;
  let announced = '';
  const request = (input: string): InferenceCall => ({
    input,
    history: [{ role: 'user', content: `state ${state}` }],
    context: 'Maya',
    uncertainty: 'unsure',
    tools: [],
    results: [],
  });
  const firstTokens: Promise<{ words: number; ms: number }>[] = [];
  const start = Date.now();
  for (const event of events) {
    await vi.advanceTimersByTimeAsync(Math.max(0, start + event.t - Date.now()));
    if (event.k === 'said') speaking.add(event.seg);
    else if (event.k === 'played') {
      speaking.delete(event.seg);
      state += 1;
    } else if (event.k === 'interrupt') speculation.cancel();
    else if (event.k === 'started') continue;
    else if (event.k === 'interim' || event.k === 'final') {
      if (event.k === 'final') {
        finals.push(event.text);
        interim = undefined;
      } else interim = event.text;
      const view = [...finals, ...(interim === undefined ? [] : [interim])].join(' ');
      if (!view || view === announced || !speculate) continue;
      announced = view;
      speculation.offer(`u-${utterance}`, view, interim === undefined, () =>
        speaking.size ? undefined : request(view),
      );
    } else {
      speculation.finalize(`u-${utterance}`, event.text);
      const call = speculation.take();
      const asked = { ...request(event.text), signal: new AbortController().signal };
      const stream = (call?.inference() ?? llm.port).stream!(asked);
      const stoppedAt = Date.now();
      const words = event.text.split(/\s+/).length;
      firstTokens.push(
        (async () => {
          for await (const _ of stream) break;
          return { words, ms: Date.now() - stoppedAt };
        })(),
      );
      call?.abort();
      utterance += 1;
      state += 1;
      finals = [];
      interim = undefined;
      announced = '';
    }
  }
  await vi.advanceTimersByTimeAsync(FIRST_TOKEN_MS);
  const turns = await Promise.all(firstTokens);
  return { turns, metrics, asked: llm.asked.length };
}

/**
 * The same call at today's endpointing: Wave 6 waits ~1 s after the caller stops (latency-evidence
 * A: 967–1040 ms on normal turns) where these calls waited ~380 ms. The caller's words and their
 * partials stay where they were; each turn's final transcript and its end move 620 ms later, and
 * everything after them with it.
 */
function atWave6Endpoint(events: readonly LiveEvent[]): LiveEvent[] {
  let offset = 0;
  return events.map((event, index) => {
    const next = events[index + 1];
    const committing =
      event.k === 'stopped'
        ? events[index - 1]?.k !== 'final' || event.t - events[index - 1]!.t > 5
        : event.k === 'final' && next?.k === 'stopped' && next.t - event.t <= 5;
    if (committing) offset += 620;
    return { ...event, t: event.t + offset };
  });
}

/**
 * Wave 8b: whether the LLM would send a request its web search tool. Maya's guard sends it to any
 * multi-word turn that is not a backchannel, cut-off or statement of plans; with these calls' words
 * anonymised, `always` is the bound: every request carries the tool.
 */
type SearchPort = Inference['sendsProviderTools'];
const always: SearchPort = () => true;

async function replayCalls(
  shift: (events: readonly LiveEvent[]) => readonly LiveEvent[],
  port?: SearchPort,
) {
  const total = { turns: 0, saved: 0, sooner: 0, oneWord: 0, oneWordSaved: 0, used: 0, extra: 0 };
  for (const call of LIVE.calls) {
    const events = shift(call.events);
    const before = await replay(events, false, port);
    const after = await replay(events, true, port);
    expect(before.turns.every((turn) => turn.ms === FIRST_TOKEN_MS)).toBe(true);
    expect(after.turns.map((turn) => turn.words)).toEqual(before.turns.map((t) => t.words));
    for (const turn of after.turns) {
      const won = FIRST_TOKEN_MS - turn.ms;
      // Never later than asking at the end of the turn.
      expect(won).toBeGreaterThanOrEqual(0);
      total.saved += won;
      if (won >= 100) total.sooner += 1;
      if (turn.words === 1) {
        total.oneWord += 1;
        total.oneWordSaved += won;
      }
    }
    total.turns += after.turns.length;
    total.used += after.metrics.used;
    // Every speculative call not used is a request the turn would not have sent.
    total.extra += after.asked - before.asked;
    expect(after.asked - before.asked).toBe(after.metrics.discarded + after.metrics.aborted);
    expect(after.metrics.onPartials).toBe(after.metrics.started);
  }
  return total;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the LLM asked on partial transcripts, replayed on the Maya calls of 2026-10-07', () => {
  it('as recorded (~380 ms endpointing): first tokens sooner on the turns whose words held', async () => {
    const total = await replayCalls((events) => events);
    // 9 of 37 turns get their first token 0.19–1.37 s sooner, 8.1 s in all (2.7 s of it on two
    // of the 7 one-word answers, whose whole wait is hidden). The turns took 28 speculative calls,
    // most of them asked on words the STT finalised a millisecond before the turn; 14 were thrown
    // away, each billed for its input.
    expect(total).toEqual({
      turns: 37,
      saved: 8_107,
      sooner: 9,
      oneWord: 7,
      oneWordSaved: 2_735,
      used: 28,
      extra: 14,
    });
  });

  it('at the Wave 6 endpoint (~1 s): the same turns hide most of their first-token wait', async () => {
    const total = await replayCalls(atWave6Endpoint);
    // The same 9 turns, now 0.81–1.37 s sooner each: 10.6 s in all.
    expect(total).toEqual({
      turns: 37,
      saved: 10_587,
      sooner: 9,
      oneWord: 7,
      oneWordSaved: 2_735,
      used: 28,
      extra: 15,
    });
  });

  it('with the web search tool on every request: only questions wait for their final words', async () => {
    // Wave 8b (issue 4): a revisable partial that asks for something (here, a question mark on two
    // or more words) is not asked ahead when it would carry the search tool. The other turns keep
    // their saving: 2 of the 9 turns wait for their final words, 0.62 s of the 8.1 s as recorded
    // and 1.86 s of the 10.6 s at the Wave 6 endpoint. (Holding back every request sent the tool
    // kept only 0.66 and 1.90 s.)
    expect(await replayCalls((events) => events, always)).toEqual({
      turns: 37,
      saved: 7_491,
      sooner: 7,
      oneWord: 7,
      oneWordSaved: 2_735,
      used: 26,
      extra: 12,
    });
    expect(await replayCalls(atWave6Endpoint, always)).toEqual({
      turns: 37,
      saved: 8_731,
      sooner: 7,
      oneWord: 7,
      oneWordSaved: 2_735,
      used: 26,
      extra: 12,
    });
  });
});
