import { describe, expect, it } from 'vitest';
import { AgentConfig, agentLlmPaths } from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';

const agent = (flow: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  AgentConfig.safeParse({
    name: 'Collections',
    mode: 'agent',
    variables: { type: 'object', properties: { full_name: {}, emi: {} } },
    decision: { enabled: true, flow },
    ...over,
  });
const messages = (parsed: ReturnType<typeof agent>) =>
  parsed.error?.issues.map((issue) => issue.message) ?? [];

describe('Jev-only reachability with a flow (AGT-4 after AGT-1)', () => {
  it('is Jev-only when the flow clarifies and every state has lines', () => {
    expect(agentLlmPaths(agent({ ...collectionsFlow(), fallback: 'clarify' }).data!)).toEqual([]);
  });

  it('reaches the LLM through an llm fallback and a state with no lines', () => {
    const flow = collectionsFlow();
    flow.nodes[1]!.say = [];
    expect(agentLlmPaths(agent(flow).data!)).toEqual([
      'decision.flow.fallback',
      'decision.flow.nodes.1.say',
    ]);
  });
});

describe('rules and re-asks against a flow (AGT-6, AGT-12)', () => {
  it('accepts listen-set rules, global rules and re-asks that name the flow', () => {
    const parsed = agent(collectionsFlow(), {
      rules: {
        listens: { identity: [{ intent: 'confirmed', lexicons: ['yes', 'speaking'] }] },
        global: [{ intent: 'stop_calling', keywords: ['stop calling'] }],
      },
      recovery: { reprompts: { payment: 'When would you be able to pay?' } },
    });
    expect(messages(parsed)).toEqual([]);
  });

  it('refuses a listen set, intent or re-ask the flow does not have', () => {
    const parsed = agent(collectionsFlow(), {
      rules: {
        listens: {
          identity: [{ intent: 'promise_to_pay', lexicons: ['yes'] }],
          billing: [{ intent: 'confirmed', lexicons: ['yes'] }],
        },
        global: [{ intent: 'refund', phrases: ['refund'] }],
      },
      recovery: { reprompts: { billing: 'Again?' } },
    });
    expect(messages(parsed)).toEqual([
      'Re-ask billing names no listen set of the flow',
      'Rule refund names no intent of the flow',
      'Rule promise_to_pay names no intent of listen set identity',
      'Rules for billing name no listen set of the flow',
    ]);
  });
});
