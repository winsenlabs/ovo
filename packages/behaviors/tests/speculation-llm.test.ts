import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentConfig, type DecisionResponse, type Inference } from '@winsendotai/ovo-contracts';
import { AgentBehavior, type SpeculationPolicy } from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';
import {
  JEV_MS,
  LLM_MS,
  atPayment,
  execution,
  firstSegment,
  flowAgent,
  settleMs,
  slowJev,
  slowLlm,
} from './speculation-fixture.ts';

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const answer = (choice: string, confidence = 0.95): DecisionResponse => ({
  modelId: 'jev-1',
  answers: {
    intent: {
      type: 'choice',
      choice,
      confidence,
      calibrationVersion: 'jev/c',
      probabilities: { pay: choice === 'pay' ? 0.9 : 0.1, other: choice === 'pay' ? 0.1 : 0.9 },
    },
  },
});

function flatAgent(
  answers: Record<string, DecisionResponse | Error>,
  speculation: Partial<SpeculationPolicy>,
  fallback: 'llm' | 'clarify' = 'llm',
  llm = slowLlm(),
) {
  const jev = slowJev(answers);
  const agent = new AgentBehavior(
    AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      clarification: 'Could you say that again?',
      decision: {
        enabled: true,
        questions: [
          {
            type: 'choice',
            id: 'intent',
            instructions: 'What does the caller want?',
            threshold: 0.8,
            fallback,
            options: [
              { key: 'pay', description: 'Pays now', outcome: { say: 'Sending the link.' } },
              { key: 'other', description: 'Anything else', outcome: {} },
            ],
          },
        ],
      },
    }),
    llm.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', decision: jev.port, speculation },
  );
  return { agent, jev, llm };
}

async function streamed(agent: AgentBehavior, text: string) {
  const iterator = agent.respondStream(text, {})[Symbol.asyncIterator]();
  const first = iterator.next();
  const ms = await settleMs(first, advance);
  return { ms, segment: (await first).value as string };
}

describe('the LLM asked alongside the decision (LAT-3)', () => {
  const unsure = { 'what is my balance': answer('pay', 0.4) };

  it('saves the decision round trip on a turn the decision hands to the LLM', async () => {
    const off = flatAgent(unsure, { partials: false, llm: false });
    const before = await streamed(off.agent, 'what is my balance');
    expect(before).toEqual({ ms: JEV_MS + LLM_MS, segment: 'A composed LLM answer.' });

    const on = flatAgent(unsure, { partials: false, llm: true });
    const after = await streamed(on.agent, 'what is my balance');
    expect(after).toEqual({ ms: LLM_MS, segment: 'A composed LLM answer.' });
    expect(before.ms - after.ms).toBe(JEV_MS);
    // One LLM call, asked exactly as the turn would have asked it after the decision.
    expect(on.llm.requests).toHaveLength(1);
    const { signal: _a, ...asked } = on.llm.requests[0]!;
    const { signal: _b, ...plain } = off.llm.requests[0]!;
    expect(asked).toEqual(plain);
    expect(on.agent.speculationMetrics.llm).toEqual({
      started: 1,
      used: 1,
      aborted: 0,
      discarded: 0,
    });
  });

  it('is on by default, and off when the agent turns it off', async () => {
    const byDefault = flatAgent(unsure, {});
    expect(byDefault.agent.speculation.llm).toBe(true);
    expect(await streamed(byDefault.agent, 'what is my balance')).toEqual({
      ms: LLM_MS,
      segment: 'A composed LLM answer.',
    });

    const { agent, llm } = flatAgent(unsure, { llm: false });
    const reply = agent.respondStream('what is my balance', {})[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(JEV_MS - 5);
    expect(llm.requests).toHaveLength(0);
    await settleMs(reply, advance);
    expect(llm.requests).toHaveLength(1);
    expect(agent.speculation.llm).toBe(false);
  });

  it('aborts the LLM when the decision answers with a scripted line', async () => {
    const { agent, llm } = flatAgent({ 'i can pay now': answer('pay') }, { llm: true });
    expect(await streamed(agent, 'I can pay now')).toEqual({
      ms: JEV_MS,
      segment: 'Sending the link.',
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    expect(agent.speculationMetrics.llm).toMatchObject({ started: 1, used: 0, aborted: 1 });
  });

  it('aborts the LLM when the decision asks the caller to clarify', async () => {
    const { agent, llm } = flatAgent(unsure, { llm: true }, 'clarify');
    expect(await streamed(agent, 'what is my balance')).toMatchObject({
      segment: 'Could you say that again?',
    });
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    expect(agent.speculationMetrics.llm).toMatchObject({ aborted: 1, used: 0 });
  });

  it('aborts the LLM with the turn when the caller barges in', async () => {
    const { agent, llm } = flatAgent(unsure, { llm: true });
    const reply = agent.respondStream('what is my balance', {})[Symbol.asyncIterator]().next();
    await vi.advanceTimersByTimeAsync(100);
    agent.cancel('caller barged in');
    await expect(reply).rejects.toThrow();
    expect(llm.requests[0]!.signal.aborted).toBe(true);
  });

  it('uses the speculative call for a non-streamed reply as well', async () => {
    const { agent, llm } = flatAgent(unsure, { llm: true });
    const reply = agent.respond('what is my balance', {});
    expect(await settleMs(reply, advance)).toBe(LLM_MS);
    expect(await reply).toBe('A composed LLM answer.');
    expect(llm.requests).toHaveLength(1);
  });

  it('runs alongside a flow decision and keeps the flow’s rejoin offer', async () => {
    const jev = slowJev({});
    const llm = slowLlm();
    const agent = flowAgent(jev.port, { partials: false, llm: true }, { llm: llm.port });
    await atPayment(agent);
    // "other" falls back to the LLM in the same state, so the early request is the turn's request.
    expect(await firstSegment(agent, 'is this about my loan?', advance)).toEqual({
      ms: LLM_MS,
      segment: 'A composed LLM answer.',
    });
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.tools.map((tool) => tool.id)).toContain('resume_flow');
    expect(agent.speculationMetrics.llm).toMatchObject({ used: 1, discarded: 0 });
  });

  it('asks again when the decision moved the flow before handing it the turn', async () => {
    // A node authored without lines hands its first turn to the LLM, in the new state.
    const flow = collectionsFlow();
    flow.nodes.push({ id: 'ask_llm', say: [], listen: 'wrapup' });
    flow.listens[1]!.intents.push({
      key: 'dispute',
      description: 'They dispute the amount',
      next: 'ask_llm',
    });
    const jev = slowJev({ 'that amount is wrong': { intent: 'dispute' } });
    const llm = slowLlm();
    const agent = flowAgent(jev.port, { partials: false, llm: true }, { llm: llm.port, flow });
    await atPayment(agent);
    const reply = await firstSegment(agent, 'that amount is wrong', advance);
    expect(reply.segment).toBe('A composed LLM answer.');
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[0]!.signal.aborted).toBe(true);
    expect(agent.speculationMetrics.llm).toMatchObject({ used: 0, discarded: 1 });
  });

  it('asks the LLM only once the turn waits on the decision model', async () => {
    const jev = slowJev({ 'kal kar dunga': { intent: 'promise_to_pay', slots: {} } });
    const llm = slowLlm();
    const agent = flowAgent(jev.port, { llm: true }, { llm: llm.port });
    // "yes" is an authored phrase: the rules tier answers it with no model, so no LLM either.
    await atPayment(agent);
    expect(llm.requests).toHaveLength(0);
    // A decision prepared and settled on the partial answers the turn with no wait: no LLM.
    agent.prepare({ turnId: 't-3', text: 'kal kar dunga', stable: true });
    await vi.advanceTimersByTimeAsync(JEV_MS);
    await firstSegment(agent, 'kal kar dunga', advance);
    expect(llm.requests).toHaveLength(0);
    expect(agent.speculationMetrics.llm.started).toBe(0);
  });

  it('never starts the LLM early for a Jev-only agent', async () => {
    const jev = slowJev({});
    const agent = flowAgent(jev.port, { llm: true });
    await atPayment(agent);
    await firstSegment(agent, 'is this about my loan?', advance);
    expect(agent.speculationMetrics.llm).toMatchObject({ started: 0 });
  });

  it('serves a matching request once, then asks the LLM itself', async () => {
    const llm = slowLlm();
    const calls: string[] = [];
    const port: Inference = {
      generate: async (request) => {
        calls.push(request.input);
        return llm.port.generate(request);
      },
    };
    const { agent } = flatAgent(unsure, { llm: true }, 'llm', { port, requests: llm.requests });
    await settleMs(agent.respond('what is my balance', {}), advance);
    await settleMs(agent.respond('what is my balance', {}), advance);
    expect(calls).toEqual(['what is my balance', 'what is my balance']);
    expect(agent.speculationMetrics.llm).toMatchObject({ started: 2, used: 2 });
  });
});
