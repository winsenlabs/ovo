import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentKnowledgePolicy,
  type Execution,
  type Inference,
  type InferenceRequest,
  type KnowledgePort,
  type KnowledgeQuery,
  type KnowledgeResult,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { Grounding, groundingMissing } from '../src/grounding.ts';

const policy = (over: Record<string, unknown> = {}) =>
  AgentKnowledgePolicy.parse({ enabled: true, minScore: 0.4, topK: 3, ...over });

const result = (over: Partial<KnowledgeResult> = {}): KnowledgeResult => ({
  revision: 'inline-3-abcd1234',
  passages: [
    {
      id: 'refunds#1',
      sourceId: 'policy',
      text: 'A refund is issued within seven working days.',
      score: 0.9,
      citation: 'Refund policy, clause 4',
    },
  ],
  ...over,
});

const port = (search: KnowledgePort['search']): KnowledgePort => ({ search });
const live = () => new AbortController().signal;

describe('retrieving what a turn may use', () => {
  it('does nothing at all when the policy is disabled', async () => {
    let called = false;
    const grounding = new Grounding(
      policy({ enabled: false }),
      port(async () => {
        called = true;
        return result();
      }),
    );
    expect(await grounding.retrieve('refund?', live())).toEqual({ kind: 'off' });
    expect(called).toBe(false);
  });

  it('asks for the authored sources and depth, with the caller’s words verbatim', async () => {
    const seen: KnowledgeQuery[] = [];
    await new Grounding(
      policy({ sourceIds: ['policy'] }),
      port(async (query) => {
        seen.push(query);
        return result();
      }),
    ).retrieve('how long does a refund take', live());
    expect(seen[0]).toEqual({
      text: 'how long does a refund take',
      topK: 3,
      sourceIds: ['policy'],
    });
  });

  it('renders the kept passages with their citations', async () => {
    const grounding = new Grounding(
      policy(),
      port(async () => result()),
    );
    const outcome = await grounding.retrieve('refund?', live());
    expect(outcome.kind).toBe('grounded');
    if (outcome.kind !== 'grounded') return;
    expect(outcome.rendered).toContain('[1] Refund policy, clause 4');
    expect(outcome.rendered).toContain('seven working days');
    expect(outcome.grounded.revision).toBe('inline-3-abcd1234');
  });

  it('keeps nothing below the authored threshold', async () => {
    const grounding = new Grounding(
      policy({ minScore: 0.95 }),
      port(async () => result()),
    );
    const outcome = await grounding.retrieve('refund?', live());
    expect(outcome).toMatchObject({ kind: 'grounded', rendered: '' });
    if (outcome.kind === 'grounded') expect(outcome.grounded.belowThreshold).toBe(1);
  });

  it('falls through on timeout rather than holding the turn open', async () => {
    const grounding = new Grounding(
      policy({ timeoutMs: 50 }),
      port(
        (_query, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason)),
          ),
      ),
    );
    const outcome = await grounding.retrieve('refund?', live());
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'timeout' });
    expect((outcome as { message: string }).message).toContain('50ms');
  });

  it('falls through when the backend fails', async () => {
    const grounding = new Grounding(
      policy(),
      port(async () => {
        throw new Error('index unavailable');
      }),
    );
    expect(await grounding.retrieve('refund?', live())).toEqual({
      kind: 'unavailable',
      reason: 'error',
      message: 'index unavailable',
    });
  });

  it('falls through when no knowledge plugin is available', async () => {
    expect(await new Grounding(policy(), undefined).retrieve('refund?', live())).toMatchObject({
      kind: 'unavailable',
      reason: 'error',
    });
  });

  it('re-validates the result itself rather than trusting the plugin', async () => {
    // Out of rank order, which is exactly what the budget trim depends on.
    const grounding = new Grounding(
      policy(),
      port(async () =>
        result({
          passages: [
            { id: 'a', sourceId: 'policy', text: 'low', score: 0.5 },
            { id: 'b', sourceId: 'policy', text: 'high', score: 0.9 },
          ],
        }),
      ),
    );
    const outcome = await grounding.retrieve('refund?', live());
    expect(outcome).toMatchObject({ kind: 'unavailable', reason: 'invalid' });
    expect((outcome as { message: string }).message).toMatch(/not ordered by score/);
  });

  it('rethrows a cancelled turn instead of reporting a retrieval failure', async () => {
    const controller = new AbortController();
    const grounding = new Grounding(
      policy({ timeoutMs: 5_000 }),
      port(
        (_query, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener('abort', () => reject(options.signal.reason)),
          ),
      ),
    );
    const pending = grounding.retrieve('refund?', controller.signal);
    controller.abort(new DOMException('caller hung up', 'AbortError'));
    await expect(pending).rejects.toThrow(/caller hung up/);
  });
});

describe('when grounding is required', () => {
  it('is satisfied only by at least one passage that cleared the threshold', () => {
    const required = policy({ requireGrounding: true });
    expect(groundingMissing(required, { kind: 'off' })).toBe(true);
    expect(
      groundingMissing(required, { kind: 'unavailable', reason: 'timeout', message: 'x' }),
    ).toBe(true);
    expect(
      groundingMissing(required, {
        kind: 'grounded',
        rendered: '',
        grounded: { used: [], belowThreshold: 2, overBudget: 0, revision: 'r' },
      }),
    ).toBe(true);
    expect(
      groundingMissing(required, {
        kind: 'grounded',
        rendered: 'x',
        grounded: {
          used: [{ id: 'a', sourceId: 'policy', text: 'x', score: 0.9 }],
          belowThreshold: 0,
          overBudget: 0,
          revision: 'r',
        },
      }),
    ).toBe(false);
  });

  it('never blocks a turn when the policy does not require grounding', () => {
    expect(groundingMissing(policy(), { kind: 'unavailable', reason: 'error', message: 'x' })).toBe(
      false,
    );
    expect(groundingMissing(undefined, { kind: 'off' })).toBe(false);
  });
});

const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };

function inference() {
  const requests: InferenceRequest[] = [];
  const llm: Inference = {
    generate: async (request) => {
      requests.push(request);
      return { kind: 'text', text: 'A composed LLM answer.' };
    },
  };
  return { llm, requests };
}

const agentConfig = (knowledge: Record<string, unknown>) =>
  AgentConfig.parse({
    name: 'Collections',
    mode: 'agent',
    context: 'The agent handles collections calls.',
    uncertainty: 'I do not have that information.',
    knowledge: { enabled: true, minScore: 0.4, topK: 3, ...knowledge },
  });

describe('an agent turn with a knowledge policy', () => {
  it('puts the retrieved passages in front of the LLM, after the briefing', async () => {
    const { llm, requests } = inference();
    const agent = new AgentBehavior(agentConfig({}), llm, execution, {
      workspaceId: 'w',
      sessionId: 's',
      knowledge: port(async () => result()),
    });
    expect(await agent.respond('how long for a refund')).toBe('A composed LLM answer.');
    expect(requests[0]!.context).toContain('The agent handles collections calls.');
    expect(requests[0]!.context).toContain('seven working days');
    expect(requests[0]!.context).toContain('[1] Refund policy, clause 4');
  });

  it('leaves the briefing untouched when nothing cleared the threshold', async () => {
    const { llm, requests } = inference();
    const agent = new AgentBehavior(agentConfig({ minScore: 0.99 }), llm, execution, {
      workspaceId: 'w',
      sessionId: 's',
      knowledge: port(async () => result()),
    });
    await agent.respond('how long for a refund');
    expect(requests[0]!.context).toBe('The agent handles collections calls.');
  });

  it('keeps the call alive on the LLM when the backend is down', async () => {
    const { llm, requests } = inference();
    const agent = new AgentBehavior(agentConfig({}), llm, execution, {
      workspaceId: 'w',
      sessionId: 's',
      knowledge: port(async () => {
        throw new Error('index unavailable');
      }),
    });
    expect(await agent.respond('how long for a refund')).toBe('A composed LLM answer.');
    expect(requests).toHaveLength(1);
    expect(agent.groundings.at(-1)!.result).toMatchObject({ kind: 'unavailable', reason: 'error' });
  });

  it('refuses rather than answering ungrounded when the policy requires grounding', async () => {
    const { llm, requests } = inference();
    const agent = new AgentBehavior(agentConfig({ requireGrounding: true }), llm, execution, {
      workspaceId: 'w',
      sessionId: 's',
      knowledge: port(async () => {
        throw new Error('index unavailable');
      }),
    });
    expect(await agent.respond('how long for a refund')).toBe('I do not have that information.');
    // The LLM is never reached: an ungrounded answer is the thing the policy exists to prevent.
    expect(requests).toHaveLength(0);
  });

  it('records every retrieval with the corpus revision that produced it', async () => {
    const { llm } = inference();
    const agent = new AgentBehavior(agentConfig({}), llm, execution, {
      workspaceId: 'w',
      sessionId: 's',
      knowledge: port(async () => result()),
    });
    await agent.respond('how long for a refund');
    expect(agent.groundings.at(-1)!.result).toMatchObject({
      kind: 'grounded',
      grounded: { revision: 'inline-3-abcd1234' },
    });
  });

  it('composes exactly as before for an agent with no policy', async () => {
    const { llm, requests } = inference();
    const agent = new AgentBehavior(
      AgentConfig.parse({ name: 'Plain', mode: 'agent' }),
      llm,
      execution,
      { workspaceId: 'w', sessionId: 's' },
    );
    expect(await agent.respond('hello')).toBe('A composed LLM answer.');
    expect(agent.groundings).toHaveLength(0);
    expect(requests[0]!.context).toBe('');
  });

  it('retrieves once and grounds the decision and the reply from the same passages', async () => {
    let searches = 0;
    const states: unknown[] = [];
    const { llm, requests } = inference();
    const config = AgentConfig.parse({
      ...agentConfig({}),
      decision: {
        enabled: true,
        state: { sources: ['last-turn', 'knowledge'] },
        questions: [
          {
            type: 'noul',
            id: 'answerable',
            instructions: 'Can this be answered from the retrieved policy?',
            threshold: 0.9,
            fallback: 'llm',
            yes: { description: 'The policy covers it', outcome: {} },
            no: { description: 'The policy does not cover it', outcome: {} },
          },
        ],
      },
    });
    const agent = new AgentBehavior(config, llm, execution, {
      workspaceId: 'w',
      sessionId: 's',
      knowledge: port(async () => {
        searches += 1;
        return result();
      }),
      decision: {
        decide: async (request) => {
          states.push(request.state);
          return {
            modelId: 'fixture',
            answers: {
              answerable: {
                type: 'noul',
                noul: 0.2,
                confidence: 0.5,
                calibrationVersion: 'fixture/cohort',
                probabilities: { yes: 0.2, no: 0.8 },
              },
            },
          };
        },
      },
    });
    await agent.respond('how long for a refund');
    // Two retrievals would let the decision and the reply disagree about what the corpus says.
    expect(searches).toBe(1);
    expect(JSON.stringify(states[0])).toContain('seven working days');
    expect(requests[0]!.context).toContain('seven working days');
  });
});
