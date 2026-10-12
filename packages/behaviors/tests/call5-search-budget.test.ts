import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentConfig,
  type Inference,
  type InferenceRequest,
  type SpeechReceipt,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { execution, settleMs, sleep } from './speculation-fixture.ts';

/**
 * Wave 9, issue D8: Maya call 10d5ef30 (2026-10-12). Three requests that searched were thrown away
 * and a second search was billed for words that held theirs: turn 18's partial "Yeah, dude." (asked
 * ahead, `openai:aborted:11`, its search billed, then turn 18's own request searched again 4.9 s
 * later), and the replies to turn 7 ("…December 21st is?", `openai:aborted:8`) and turn 4 ("Yeah,
 * December 26.", `openai:aborted:6`), which AGT-10 superseded with the caller's next words.
 */
const TURN7 =
  "I'll be flying out of Chennai and I'll return back to Chennai only. Uh, I expect to fly out on... December 21st is?";
const SEARCH_AFTER_MS = 150;
const SEARCH_MS = 1_500;
const LLM_MS = 1_800;

type Activity = { tool: string; id: string; signal: AbortSignal; atMs: number } & (
  | { phase: 'started' }
  | {
      phase: 'finished';
      outcome: 'succeeded' | 'failed' | 'cancelled';
      durationMs: number;
      results?: number;
    }
);

/**
 * OpenAI with its web search, as the inference port reports it (plugin-kit `InferenceActivity`):
 * every request sent the tool searches, `SEARCH_AFTER_MS` in, and answers once the search is back.
 */
function searchingLlm(results = 5) {
  const requests: InferenceRequest[] = [];
  const listeners = new Set<(activity: Activity) => void>();
  const emit = (activity: Activity) => listeners.forEach((listener) => listener(activity));
  let ids = 0;
  const port: Inference & { observeActivity(fn: (a: Activity) => void): () => void } = {
    generate: () => Promise.reject(new Error('streamed only')),
    async *stream(request) {
      requests.push(request);
      const { signal } = request;
      if (request.providerTools !== false) {
        await sleep(SEARCH_AFTER_MS, signal);
        const id = `ws-${++ids}`;
        const call = { tool: 'web_search', id, signal };
        emit({ ...call, phase: 'started', atMs: Date.now() });
        const finished = (outcome: 'succeeded' | 'cancelled', durationMs: number) =>
          emit({ ...call, phase: 'finished', outcome, durationMs, atMs: Date.now(), results });
        try {
          await sleep(SEARCH_MS, signal);
        } catch (error) {
          finished('cancelled', 0);
          throw error;
        }
        finished('succeeded', SEARCH_MS);
      }
      await sleep(LLM_MS - SEARCH_MS, signal);
      yield { kind: 'text-delta', delta: 'Here is what I found.' };
      yield { kind: 'finish' };
    },
    sendsProviderTools: (request) => request.providerTools !== false,
    observeActivity(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  /** Requests sent the search tool. */
  const searched = () => requests.filter((request) => request.providerTools !== false);
  return { port, requests, searched };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

const played = (text: string, epoch: number): SpeechReceipt => ({
  id: crypto.randomUUID(),
  text,
  epoch,
  state: 'completed',
  evidence: 'confirmed',
});

let epoch = 1;

const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";

/** Maya, greeted: no decision model, so every caller turn goes to the LLM. */
async function maya(llm = searchingLlm()) {
  const agent = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      opening: { lines: [GREETING] },
      ending: { llmTool: true },
    }),
    llm.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1' },
  );
  agent.beginTurn(++epoch);
  await agent.respond('', { inputEvent: 'opening' });
  agent.onPlayback(played(GREETING, epoch));
  return { agent, llm };
}

/** The engine answering utterance `turnId`: finalize, then the streamed turn, played to the end. */
async function turn(agent: AgentBehavior, turnId: string, text: string, merged = false) {
  epoch += 1;
  agent.finalize({ turnId, text, merged });
  agent.beginTurn(epoch);
  const said: string[] = [];
  const iterator = agent.respondStream(text, {})[Symbol.asyncIterator]();
  for (;;) {
    const next = iterator.next();
    await settleMs(next, advance);
    const { done, value } = await next;
    if (done) break;
    said.push(value as string);
  }
  for (const line of said) agent.onPlayback(played(line, epoch));
  return said;
}

describe('call 10d5ef30 D8: one web search for the caller’s words', () => {
  it('turn 18: a search asked ahead on "Yeah, dude." is the turn’s search', async () => {
    const { agent, llm } = await maya();
    // The statement partial is asked ahead with the tool, and searches (billed).
    agent.prepare({ turnId: 'turn-18', text: 'Yeah, dude.', stable: false });
    await advance(1_400);
    expect(llm.searched().map((request) => request.input)).toEqual(['Yeah, dude.']);
    // The caller went on: the final words differ, so that call is thrown away, its search not yet
    // back. The turn's own request on words that hold the partial's is sent no search tool, though
    // they ask ("why"): the partial's search was the turn's.
    expect(await turn(agent, 'turn-18', "Yeah, dude. That's why I'm asking.")).toEqual([
      'Here is what I found.',
    ]);
    expect(llm.requests.map((request) => [request.input, request.providerTools])).toEqual([
      ['Yeah, dude.', undefined],
      ["Yeah, dude. That's why I'm asking.", false],
    ]);
  });

  it('turns 7–8: a reply AGT-10 superseded while it searched leaves the merged turn none', async () => {
    const { agent, llm } = await maya();
    epoch += 1;
    agent.finalize({ turnId: 'turn-7', text: TURN7, merged: false });
    agent.beginTurn(epoch);
    const first = agent.respondStream(TURN7, {})[Symbol.asyncIterator]().next();
    first.catch(() => undefined);
    // Live it searched for 1.98 s before "And fly back in, uh-" superseded it.
    await advance(1_980);
    agent.cancel('turn superseded');
    await advance(0);
    const merged = `${TURN7} And fly back in on January 5th, please.`;
    expect(await turn(agent, 'turn-8', merged, true)).toEqual(['Here is what I found.']);
    expect(llm.searched().map((request) => request.input)).toEqual([TURN7]);
  });

  it('a search thrown away before it came back leaves words that ask something new theirs', async () => {
    // Turns 4–5: "Yeah, December 26." searched; "Can you tell me about how pricey flights are…"
    // superseded it 1.0 s in, before any result: the flights were never looked up.
    const { agent, llm } = await maya();
    epoch += 1;
    agent.finalize({ turnId: 'turn-4', text: 'Yeah, December 26.', merged: false });
    agent.beginTurn(epoch);
    const first = agent.respondStream('Yeah, December 26.', {})[Symbol.asyncIterator]().next();
    first.catch(() => undefined);
    await advance(1_000);
    agent.cancel('turn superseded');
    await advance(0);
    const merged =
      'Yeah, December 26. Can you tell me about how pricey flights are and things like that?';
    await turn(agent, 'turn-5', merged, true);
    expect(llm.searched().map((request) => request.input)).toEqual(['Yeah, December 26.', merged]);
  });

  it('a search that found nothing leaves the next request its own', async () => {
    const { agent, llm } = await maya(searchingLlm(0));
    agent.prepare({ turnId: 'turn-1', text: 'Yeah, dude.', stable: false });
    await advance(1_800);
    await turn(agent, 'turn-1', "Yeah, dude. That's why I'm asking.");
    expect(llm.searched()).toHaveLength(2);
  });

  it('a search a reply used does not hold back the next turn', async () => {
    const { agent, llm } = await maya();
    await turn(agent, 'turn-1', 'Yes.');
    await turn(agent, 'turn-2', 'Yes, and the hotels too.');
    expect(llm.searched()).toHaveLength(2);
  });
});
