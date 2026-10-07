import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type DecisionAnswer,
  type DecisionPort,
  type DecisionRequest,
  type DecisionResponse,
  type Execution,
  type Inference,
  type InferenceRequest,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';

const question = {
  type: 'choice' as const,
  id: 'intent',
  instructions: 'What does the caller want?',
  threshold: 0.8,
  fallback: 'llm' as const,
  options: [
    {
      key: 'pay',
      description: 'Wants to pay now',
      outcome: { say: 'I am sending a payment link.' },
    },
    { key: 'other', description: 'Anything else', outcome: {} },
  ],
};

const config = (over: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    name: 'Collections',
    mode: 'agent',
    clarification: 'Could you say that again?',
    decision: {
      enabled: true,
      questions: [question],
      state: { sources: ['last-turn', 'variables'] },
      // LAT-3 (the LLM asked alongside the decision) is on by default; these tests count LLM calls.
      speculation: { llm: false },
      ...over,
    },
  });

const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };

function inference() {
  const requests: InferenceRequest[] = [];
  const port: Inference = {
    generate: async (request) => {
      requests.push(request);
      return { kind: 'text', text: 'A composed LLM answer.' };
    },
  };
  return { port, requests };
}

const answer = (over: Partial<DecisionAnswer> = {}): DecisionResponse => ({
  modelId: 'jev-1',
  answers: {
    intent: {
      type: 'choice',
      choice: 'pay',
      confidence: 0.93,
      calibrationVersion: 'jev-1/cohort-a',
      probabilities: { pay: 0.9, other: 0.1 },
      ...over,
    } as DecisionAnswer,
  },
});

const behaviour = (decision: DecisionPort | undefined, over?: Record<string, unknown>) => {
  const llm = inference();
  return {
    llm,
    agent: new AgentBehavior(config(over), llm.port, execution, {
      workspaceId: 'w-1',
      sessionId: 's-1',
      ...(decision ? { decision } : {}),
    }),
  };
};

describe('an agent turn with a decision policy', () => {
  it('speaks the authored outcome and never calls the LLM at all', async () => {
    const { agent, llm } = behaviour({ decide: async () => answer() });
    expect(await agent.respond('I can pay today', { accountId: 'A-1' })).toBe(
      'I am sending a payment link.',
    );
    // The point of a decision model in front of the reply: on the confident path there is no
    // LLM round trip to wait for, so this count is the latency claim.
    expect(llm.requests).toHaveLength(0);
  });

  it('grounds the decision in the caller turn and the authored variables', async () => {
    const seen: DecisionRequest[] = [];
    const { agent } = behaviour({
      decide: async (request) => {
        seen.push(request);
        return answer();
      },
    });
    await agent.respond('I can pay today', { accountId: 'A-1' });
    expect(seen[0]!.state).toEqual({
      lastCallerTurn: 'I can pay today',
      variables: { accountId: 'A-1' },
    });
  });

  it('falls back to the LLM below the authored threshold', async () => {
    const { agent, llm } = behaviour({ decide: async () => answer({ confidence: 0.4 }) });
    expect(await agent.respond('maybe, I am not sure')).toBe('A composed LLM answer.');
    expect(llm.requests).toHaveLength(1);
  });

  it('asks for clarification below threshold when that is what was authored', async () => {
    const { agent, llm } = behaviour(
      { decide: async () => answer({ confidence: 0.4 }) },
      {
        questions: [{ ...question, fallback: 'clarify' }],
      },
    );
    expect(await agent.respond('mmm')).toBe('Could you say that again?');
    expect(llm.requests).toHaveLength(0);
  });

  it('keeps the call alive on the LLM when the decision model is down', async () => {
    const { agent, llm } = behaviour({
      decide: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect(await agent.respond('I can pay today')).toBe('A composed LLM answer.');
    expect(llm.requests).toHaveLength(1);
    expect(agent.decisions.at(-1)!.result).toMatchObject({ kind: 'unavailable', reason: 'error' });
  });

  it('keeps the call alive when the decision model answers incoherently', async () => {
    const { agent, llm } = behaviour({
      decide: async () => answer({ probabilities: { pay: 0.2, other: 0.2 } }),
    });
    expect(await agent.respond('I can pay today')).toBe('A composed LLM answer.');
    expect(llm.requests).toHaveLength(1);
    expect(agent.decisions.at(-1)!.result).toMatchObject({
      kind: 'unavailable',
      reason: 'invalid',
    });
  });

  it('records every decision with its calibration identity for later review', async () => {
    const { agent } = behaviour({ decide: async () => answer() });
    await agent.respond('I can pay today');
    const record = agent.decisions.at(-1)!;
    expect(record.turn).toBe(1);
    expect(record.result).toMatchObject({
      kind: 'decided',
      modelId: 'jev-1',
      resolutions: [
        { used: true, questionId: 'intent', answer: { calibrationVersion: 'jev-1/cohort-a' } },
      ],
    });
  });

  it('runs no decision and reaches the LLM when the policy is off', async () => {
    let called = false;
    const { agent, llm } = behaviour(
      {
        decide: async () => {
          called = true;
          return answer();
        },
      },
      { enabled: false },
    );
    expect(await agent.respond('hello')).toBe('A composed LLM answer.');
    expect(called).toBe(false);
    expect(llm.requests).toHaveLength(1);
    expect(agent.decisions).toHaveLength(0);
  });

  it('composes exactly as before for an agent with no policy', async () => {
    const llm = inference();
    const agent = new AgentBehavior(
      AgentConfig.parse({ name: 'Plain', mode: 'agent' }),
      llm.port,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1' },
    );
    expect(await agent.respond('hello')).toBe('A composed LLM answer.');
    expect(agent.decisions).toHaveLength(0);
  });

  it('streams the authored outcome as one segment without an LLM stream', async () => {
    const { agent, llm } = behaviour({ decide: async () => answer() });
    const segments: string[] = [];
    for await (const segment of agent.respondStream('I can pay today')) segments.push(segment);
    expect(segments).toEqual(['I am sending a payment link.']);
    expect(llm.requests).toHaveLength(0);
  });

  it('remembers a spoken decision outcome once it is played', async () => {
    let turn = 0;
    const { agent, llm } = behaviour({
      // Confident on the first turn, unsure on the second, so the second turn reaches the LLM.
      decide: async () => answer({ confidence: turn++ === 0 ? 0.93 : 0.4 }),
    });
    agent.beginTurn(0);
    const said = await agent.respond('I can pay today');
    expect(said).toBe('I am sending a payment link.');
    agent.onPlayback({
      id: crypto.randomUUID(),
      text: said,
      epoch: 0,
      state: 'completed',
      evidence: 'confirmed',
    });
    agent.beginTurn(1);
    await agent.respond('what else can you do');
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.history).toContainEqual({
      role: 'assistant',
      content: 'I am sending a payment link.',
    });
  });

  it('forgets a decision outcome that was generated but never played', async () => {
    let turn = 0;
    const { agent, llm } = behaviour({
      decide: async () => answer({ confidence: turn++ === 0 ? 0.93 : 0.4 }),
    });
    agent.beginTurn(0);
    await agent.respond('I can pay today');
    agent.beginTurn(1);
    await agent.respond('what else can you do');
    expect(JSON.stringify(llm.requests[0]!.history)).not.toContain('payment link');
  });

  it('drops a decision for a turn the caller already abandoned', async () => {
    let released: (() => void) | undefined;
    const agentUnderTest = new AgentBehavior(config(), inference().port, execution, {
      workspaceId: 'w-1',
      sessionId: 's-1',
      decision: {
        decide: (_request, options) =>
          new Promise((_resolve, reject) => {
            released = () => reject(options.signal.reason);
            options.signal.addEventListener('abort', released);
          }),
      },
    });
    const pending = agentUnderTest.respond('I can pay today');
    agentUnderTest.cancel('caller hung up');
    await expect(pending).rejects.toThrow();
    expect(released).toBeDefined();
  });
});
