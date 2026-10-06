import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  readSessionEvent,
  type DecisionPort,
  type EventSink,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { collect, execution, llm } from './agent-call-control-fixture.ts';
import { collectionsFlow, scriptedJev, type Scripted } from './flow-fixture.ts';

const call = { full_name: 'Ravi Kumar', emi: 'four thousand rupees' };

function agent(script: Scripted[], over: Record<string, unknown> = {}, replies = []) {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const sink: EventSink = {
    append: async (type, payload) => {
      readSessionEvent(type, payload); // every recorded event is valid for storage
      events.push({ type, payload });
    },
  };
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      variables: {
        type: 'object',
        properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
      },
      decision: { enabled: true, flow: collectionsFlow() },
      ...over,
    }),
    llm(replies).port,
    execution,
    {
      workspaceId: 'w-1',
      sessionId: 's-1',
      decision: scriptedJev(script).port as DecisionPort,
      events: sink,
    },
  );
  return { behavior, events };
}

// Integration glue between the flow lane's transitions and the outcomes lane's event sink (AGT-8).
describe('a flow agent records its outcome events', () => {
  it('records each state, the routing tier, the disposition and the captured slots', async () => {
    const { behavior, events } = agent([
      { intent: 'promise_to_pay', slots: { ptp_when: 'today' } },
    ]);
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    await collect(behavior.respondStream('yes', call));
    await collect(behavior.respondStream('I will pay today', call));
    expect(events.map(({ type, payload }) => [type, payload])).toEqual([
      ['flow.state', { turn: 0, to: 'greet', reason: 'start' }],
      ['flow.state', { turn: 1, from: 'greet', to: 'disclose', reason: 'rule' }],
      [
        'turn.route',
        {
          turn: 1,
          tier: 'rule',
          node: 'greet',
          listen: 'identity',
          intent: 'confirmed',
          confidence: 1,
        },
      ],
      ['flow.state', { turn: 2, from: 'disclose', to: 'ptp_today', reason: 'decision' }],
      [
        'disposition',
        { disposition: 'promise_to_pay:today', turn: 2, node: 'ptp_today', source: 'jev' },
      ],
      ['variables.captured', { turn: 2, variables: { ptp_when: 'today' } }],
      [
        'turn.route',
        expect.objectContaining({
          turn: 2,
          tier: 'jev',
          node: 'disclose',
          listen: 'payment',
          intent: 'promise_to_pay',
          slots: { ptp_when: 'today' },
        }),
      ],
    ]);
  });

  it('records a fallback to the LLM, and a stay enters no state', async () => {
    const { behavior, events } = agent([{ intent: 'other' }]);
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    events.length = 0;
    await collect(behavior.respondStream('what is this about?', call));
    expect(events.map((event) => event.type)).not.toContain('flow.state');
    expect(events.find((event) => event.type === 'turn.route')!.payload).toMatchObject({
      turn: 1,
      tier: 'llm',
      node: 'greet',
      listen: 'identity',
      fallbackReason: 'other',
    });
  });

  it('checks the reply the LLM hands back through resume_flow', async () => {
    const { behavior } = agent(
      [{ intent: 'other' }],
      { guardrail: { mode: 'block', safeLine: 'Let me confirm that with my team.' } },
      [
        {
          kind: 'tool',
          toolId: 'resume_flow',
          input: { reply: 'I can waive the late fee for you.', resume_at: 'identity' },
        },
      ] as never,
    );
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    expect(await behavior.respond('can you do anything?', call)).toBe(
      'Let me confirm that with my team.',
    );
  });
});
