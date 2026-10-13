import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentConfig, type Inference, type SpeechReceipt } from '@winsendotai/ovo-contracts';
import { AgentBehavior, type SpeculationPolicy } from '../src/index.ts';
import {
  LLM_MS,
  atPayment,
  execution,
  flowAgent,
  settleMs,
  sleep,
  slowJev,
  slowLlm,
} from './speculation-fixture.ts';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Maya: no decision model, every caller turn goes to the LLM (call 6e1a4e3a's agent). */
function maya(speculation: Partial<SpeculationPolicy> = {}, llm = slowLlm()) {
  const agent = new AgentBehavior(
    AgentConfig.parse({
      name: 'Maya',
      mode: 'agent',
      uncertainty: "I'm not completely sure about that. Want me to look it up?",
      opening: { lines: [GREETING] },
      languages: { allowed: ['en', 'hi'] },
      ending: { llmTool: true },
    }),
    llm.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', speculation },
  );
  return { agent, llm };
}

const played = (text: string, epoch: number): SpeechReceipt => ({
  id: crypto.randomUUID(),
  text,
  epoch,
  state: 'completed',
  evidence: 'confirmed',
});

/** The greeting, played to the end: the agent is silent and the caller speaks. */
async function greeted(agent: AgentBehavior): Promise<void> {
  agent.beginTurn(1);
  await agent.respond('', { inputEvent: 'opening' });
  agent.onPlayback(played(GREETING, 1));
}

const epochs = new WeakMap<AgentBehavior, number>();

/**
 * The engine answering utterance `turnId`: finalize, then the streamed turn on the same tick, and
 * the reply played to the end.
 */
async function turn(agent: AgentBehavior, turnId: string, text: string) {
  const epoch = (epochs.get(agent) ?? 1) + 1;
  epochs.set(agent, epoch);
  agent.finalize({ turnId, text, merged: false });
  agent.beginTurn(epoch);
  const iterator = agent.respondStream(text, {})[Symbol.asyncIterator]();
  const first = iterator.next();
  const ms = await settleMs(first, advance);
  const segments = [(await first).value as string];
  for (;;) {
    const next = iterator.next();
    await settleMs(next, advance);
    const { done, value } = await next;
    if (done) break;
    segments.push(value as string);
  }
  for (const segment of segments) agent.onPlayback(played(segment, epoch));
  return { ms, segment: segments[0]! };
}

describe('the LLM asked on the caller’s partial transcript (Wave 8, latency fix 4)', () => {
  it('asks on words that held, and the turn speaks that call’s answer sooner', async () => {
    const question = 'What is the weather like in Zagreb in December?';
    const plain = maya({ llmPartials: false });
    await greeted(plain.agent);
    expect(await turn(plain.agent, 'turn-1', question)).toEqual({
      ms: LLM_MS,
      segment: 'A composed LLM answer.',
    });

    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: question, stable: false });
    await advance(249);
    expect(llm.requests).toHaveLength(0);
    await advance(1);
    expect(llm.requests).toHaveLength(1);
    // The caller's turn ends 400 ms after the call started: 100 ms of the LLM's wait are left.
    await advance(400);
    expect(await turn(agent, 'turn-1', question)).toEqual({
      ms: LLM_MS - 400,
      segment: 'A composed LLM answer.',
    });
    expect(llm.requests).toHaveLength(1);
    // Asked exactly as the turn asks: the same words, history, briefing and tools.
    const { signal: _a, ...asked } = llm.requests[0]!;
    const { signal: _b, ...own } = plain.llm.requests[0]!;
    expect(asked).toEqual(own);
    expect(agent.speculationMetrics.llm).toEqual({
      started: 1,
      used: 1,
      aborted: 0,
      discarded: 0,
      onPartials: 1,
    });
  });

  it('call 6e1a4e3a turn 1: a one-word answer held 1.9 s gets its first words 1.7 s sooner', async () => {
    // Live: the partial "हाँ।" at 08:00:28.579, the turn at 30.515 (held as a possible
    // backchannel), the LLM's first token 2,321 ms after that.
    const FIRST_TOKEN_MS = 2_321;
    const requests: unknown[] = [];
    const port: Inference = {
      generate: () => Promise.reject(new Error('streamed only')),
      async *stream(request) {
        requests.push(request);
        await sleep(FIRST_TOKEN_MS, request.signal);
        yield { kind: 'text-delta', delta: 'Great! Where in Europe are you heading?' };
        yield { kind: 'finish' };
      },
    };
    const live = async (speculate: boolean) => {
      const { agent } = maya({ llmPartials: speculate }, { port, requests: [] });
      await greeted(agent);
      agent.prepare({ turnId: 'turn-1', text: 'हाँ।', stable: false });
      await advance(30_515 - 28_579);
      return (await turn(agent, 'turn-1', 'हाँ।')).ms;
    };
    // `settleMs` steps the clock 5 ms at a time.
    const near = (ms: number, expected: number) => expect(Math.abs(ms - expected)).toBeLessThan(5);
    near(await live(false), FIRST_TOKEN_MS);
    // Asked 250 ms after the partial: 2,321 - (1,936 - 250) = 635 ms left after the turn.
    near(await live(true), 635);
    expect(requests).toHaveLength(2);
  });

  it('aborts the call when the final words differ, and the turn asks for its own', async () => {
    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Can I get food?', stable: false });
    await advance(300);
    const final = 'I am Indian vegetarian. Can I get food there?';
    expect(await turn(agent, 'turn-1', final)).toMatchObject({ ms: LLM_MS });
    expect(llm.requests.map((request) => request.input)).toEqual(['Can I get food?', final]);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    expect(agent.speculationMetrics.llm).toMatchObject({ used: 0, discarded: 1, onPartials: 1 });
  });

  it('asks only on a finished sentence that held for the debounce', async () => {
    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Can you tell me about', stable: false });
    await advance(1_000);
    agent.prepare({ turnId: 'turn-1', text: 'Can you tell me about Zagreb?', stable: false });
    await advance(200);
    agent.prepare({
      turnId: 'turn-1',
      text: 'Can you tell me about Zagreb? And Split.',
      stable: false,
    });
    await advance(200);
    expect(llm.requests).toHaveLength(0);
    await advance(50);
    expect(llm.requests.map((request) => request.input)).toEqual([
      'Can you tell me about Zagreb? And Split.',
    ]);
  });

  it('asks words the STT finalised at once, and leaves fewer than llmMinWords alone', async () => {
    const { agent, llm } = maya({ llmMinWords: 2 });
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Yes.', stable: true });
    await advance(1_000);
    expect(llm.requests).toHaveLength(0);
    agent.prepare({ turnId: 'turn-2', text: 'Yes, Zagreb.', stable: true });
    expect(llm.requests).toHaveLength(1);
  });

  it('never asks while the agent is still speaking: its lines would change the history', async () => {
    const { agent, llm } = maya();
    agent.beginTurn(1);
    await agent.respond('', { inputEvent: 'opening' });
    agent.prepare({ turnId: 'turn-1', text: 'Hello?', stable: false });
    await advance(1_000);
    expect(llm.requests).toHaveLength(0);
    agent.onPlayback(played(GREETING, 1));
    agent.prepare({ turnId: 'turn-1', text: 'Hello? Zagreb.', stable: false });
    await advance(250);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.history).toEqual([{ role: 'assistant', content: GREETING }]);
  });

  it('keeps one call in flight, and one per utterance on revisable words', async () => {
    const { agent, llm } = maya({ llmMaxPartialCalls: 2 });
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Zagreb.', stable: false });
    await advance(250);
    agent.prepare({ turnId: 'turn-1', text: 'Zagreb. In December.', stable: false });
    await advance(250);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    expect(llm.requests[1]!.signal.aborted).toBe(false);
    agent.prepare({ turnId: 'turn-1', text: 'Zagreb. In December. For a week.', stable: false });
    await advance(250);
    expect(llm.requests).toHaveLength(2);

    const byDefault = maya();
    await greeted(byDefault.agent);
    byDefault.agent.prepare({ turnId: 'turn-1', text: 'Zagreb.', stable: false });
    await advance(250);
    byDefault.agent.prepare({ turnId: 'turn-1', text: 'Zagreb. In December.', stable: false });
    await advance(250);
    expect(byDefault.llm.requests).toHaveLength(1);
  });

  it('drops the call for an utterance the engine discards, supersedes or cuts', async () => {
    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Okay.', stable: false });
    await advance(250);
    agent.discard('turn-1', 'reset');
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    agent.prepare({ turnId: 'turn-2', text: 'Sure.', stable: false });
    await advance(100);
    // Words waiting out the debounce for an utterance the engine drops are never asked about.
    agent.discard('turn-2', 'reset');
    await advance(500);
    expect(llm.requests).toHaveLength(1);
    agent.prepare({ turnId: 'turn-3', text: 'Fine.', stable: false });
    await advance(250);
    agent.cancel();
    expect(llm.requests[1]!.signal.aborted).toBe(true);
    expect(agent.speculationMetrics.llm).toMatchObject({ onPartials: 2, discarded: 2, used: 0 });
  });

  it('still asks ahead once a barge-in cut the reply’s only line (Wave 10 review of B1)', async () => {
    const { agent, llm } = maya();
    await greeted(agent);
    agent.finalize({ turnId: 'turn-1', text: 'Tell me about Budapest.', merged: false });
    agent.beginTurn(2);
    const reply = agent.respond('Tell me about Budapest.', {});
    await advance(LLM_MS);
    // The caller cuts the reply's first and only line: it never enters the history, so the history
    // still ends with their words, and the engine cancels the turn.
    agent.onPlayback({ ...played(await reply, 2), state: 'interrupted' });
    agent.cancel();
    epochs.set(agent, 2);
    agent.prepare({ turnId: 'turn-2', text: 'What about Prague?', stable: true });
    await advance(300);
    // Before: nothing asked until the turn ended, 300 ms later (the review's probe: first audio
    // 8,451 ms in place of 7,851 ms, the 600 ms from stable partial to endpoint).
    expect(llm.requests.map((request) => request.input)).toEqual([
      'Tell me about Budapest.',
      'What about Prague?',
    ]);
    expect(await turn(agent, 'turn-2', 'What about Prague?')).toEqual({
      ms: LLM_MS - 300,
      segment: 'A composed LLM answer.',
    });
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.history?.at(-1)).toEqual({
      role: 'user',
      content: 'Tell me about Budapest.',
    });
  });

  it('keeps a barge-in’s words across cancel, and asks nothing once the engine ends the call', async () => {
    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Wait, what about Rome?', stable: false });
    await advance(100);
    // A barge-in: the engine cancels the reply, and the words that interrupted it are still asked.
    agent.cancel();
    await advance(150);
    expect(llm.requests.map((request) => request.input)).toEqual(['Wait, what about Rome?']);
    agent.prepare({ turnId: 'turn-2', text: 'Okay, bye.', stable: false });
    await advance(100);
    // The caller hangs up: TurnRunner.dispose discards the open utterance, then cancels (with
    // cancel alone, "Okay, bye." would be asked 150 ms later, with no turn to take it).
    agent.discard('turn-2', 'reset');
    agent.cancel();
    await advance(1_000);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
  });

  it('does not use a call asked on a full stop for a final with a question mark', async () => {
    // The OpenAI plugin sends the web search tool on the question mark, so the two ask differently.
    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Is the museum open.', stable: false });
    await advance(300);
    expect(await turn(agent, 'turn-1', 'Is the museum open?')).toMatchObject({ ms: LLM_MS });
    expect(llm.requests.map((request) => request.input)).toEqual([
      'Is the museum open.',
      'Is the museum open?',
    ]);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    // Words that differ only in case or a full stop still use the call.
    const same = maya();
    await greeted(same.agent);
    same.agent.prepare({ turnId: 'turn-1', text: 'zagreb in december.', stable: false });
    await advance(300);
    expect(await turn(same.agent, 'turn-1', 'Zagreb in December')).toMatchObject({
      ms: LLM_MS - 50,
    });
    expect(same.llm.requests).toHaveLength(1);
  });

  it('aborts a call its turn never asks for (the language line answers it)', async () => {
    const { agent, llm } = maya();
    await greeted(agent);
    agent.prepare({ turnId: 'turn-1', text: 'Sure.', stable: false });
    await advance(250);
    await turn(agent, 'turn-1', 'Sure.');
    expect(llm.requests).toHaveLength(1);
    // The same words, then nothing the LLM would be asked: a Russian final is not understood.
    agent.prepare({ turnId: 'turn-2', text: 'Okay.', stable: false });
    await advance(250);
    const ru = 'Нет, это всё.';
    expect((await turn(agent, 'turn-2', ru)).segment).toContain('Could you say that again?');
    expect(llm.requests[1]!.signal.aborted).toBe(true);
  });

  it('is off for an agent with a decision model, and when the agent turns it off', async () => {
    const jev = slowJev({});
    const llm = slowLlm();
    const flow = flowAgent(jev.port, {}, { llm: llm.port });
    await atPayment(flow);
    const before = llm.requests.length;
    flow.prepare({ turnId: 'turn-9', text: 'Is this about my loan?', stable: false });
    await advance(1_000);
    expect(llm.requests).toHaveLength(before);

    const off = maya({ llmPartials: false });
    await greeted(off.agent);
    off.agent.prepare({ turnId: 'turn-1', text: 'Zagreb.', stable: true });
    await advance(1_000);
    expect(off.llm.requests).toHaveLength(0);
  });
});
