import { describe, expect, it } from 'vitest';
import { AgentConfig, type DecisionPort } from '@winsendotai/ovo-contracts';
import { AgentBehavior, UNVERIFIED_FACTS_NOTICE, type FlowSession } from '../src/index.ts';
import { collect, execution, llm } from './agent-call-control-fixture.ts';
import { collectionsFlow, scriptedJev, type Scripted } from './flow-fixture.ts';

const variables = {
  type: 'object',
  properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
  additionalProperties: false,
};
const call = { full_name: 'Ravi Kumar', emi: 'four thousand rupees' };

function agent(
  script: Scripted[] = [],
  over: Record<string, unknown> = {},
  replies: Parameters<typeof llm>[0] = [],
) {
  const jev = scriptedJev(script);
  const model = llm(replies);
  const { decision, ...rest } = over as { decision?: Record<string, unknown> };
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      variables,
      decision: { enabled: true, flow: collectionsFlow(), ...decision },
      ...rest,
    }),
    model.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', decision: jev.port as DecisionPort },
  );
  return { behavior, jev, model };
}

/**
 * These cover the agent orchestration that the flow lane requested from the owner of `agent.ts`
 * (wave 3 cross-lane request): the start node as the greeting, identity-gated facts, the LLM
 * rejoin and one segment per line. They run once that wiring is in; until then the routing path
 * is covered by `flow-agent.test.ts`.
 */
const wired = 'flow' in agent().behavior;
/** Read through a cast so this file compiles before the wiring adds `AgentBehavior.flow`. */
const flowOf = (behavior: AgentBehavior) => (behavior as { flow?: FlowSession }).flow;

describe.skipIf(!wired)('an agent wired to its flow', () => {
  it('greets first with the start node, one segment per line', async () => {
    const { behavior } = agent();
    expect(behavior.speaksFirst()).toBe(true);
    expect(behavior.voicemail(call)).toBe('');
    expect(await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }))).toEqual([
      "Hello, I'm calling from CreditMantri.",
      'Am I speaking with Ravi Kumar?',
    ]);
    // The caller's first reply is judged in the greeting's listen set, not used to enter it.
    expect(await collect(behavior.respondStream('yes', call))).toEqual([
      'Your EMI of four thousand rupees could not be collected.',
      'When would you be able to make this payment?',
    ]);
  });

  it('speaks an authored opening before the start node', async () => {
    const { behavior } = agent([], { opening: { lines: ['Good morning.'] } });
    expect(await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }))).toEqual([
      'Good morning.',
      "Hello, I'm calling from CreditMantri.",
      'Am I speaking with Ravi Kumar?',
    ]);
  });

  it('withholds the call facts from the LLM until identity is confirmed', async () => {
    const { behavior, model } = agent([{ intent: 'other' }, { intent: 'other' }]);
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    await behavior.respond('what is this about?', call);
    expect(model.requests[0]!.context).toContain(UNVERIFIED_FACTS_NOTICE);
    expect(model.requests[0]!.context).not.toContain('four thousand rupees');
    await behavior.respond('yes', call);
    await behavior.respond('can I pay half?', call);
    expect(model.requests[1]!.context).toContain('- emi: four thousand rupees');
  });

  it('lets the LLM hand the call back to the flow', async () => {
    const { behavior, model } = agent([{ intent: 'other' }], {}, [
      {
        kind: 'tool',
        toolId: 'resume_flow',
        input: {
          reply: 'It is about your loan. Is this Ravi?',
          resume_at: 'identity',
          action: 'none',
        },
      },
    ]);
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    expect(await behavior.respond('what is this about?', call)).toBe(
      'It is about your loan. Is this Ravi?',
    );
    expect(model.requests[0]!.tools.map((tool) => tool.id)).toContain('resume_flow');
    expect(flowOf(behavior)!.path.at(-1)).toMatchObject({ tier: 'llm', intent: 'identity' });
    expect(await behavior.respond('yes', call)).toContain('Your EMI');
  });

  it('neither greets nor routes by a disabled flow', () => {
    const { behavior } = agent([], { decision: { enabled: false } });
    expect(behavior.speaksFirst()).toBe(false);
    expect(flowOf(behavior)).toBeUndefined();
  });
});
