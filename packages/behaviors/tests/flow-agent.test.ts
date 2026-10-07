import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  FlowCompileError,
  type DecisionPort,
  type Execution,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { llm, receipt } from './agent-call-control-fixture.ts';
import { collectionsFlow, scriptedJev, type Scripted } from './flow-fixture.ts';

const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };
const variables = {
  type: 'object',
  properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
  additionalProperties: false,
};
const call = { full_name: 'Ravi Kumar', emi: 'four thousand rupees' };

function agent(script: Scripted[] = [], over: Record<string, unknown> = {}) {
  const jev = scriptedJev(script);
  const model = llm();
  // LAT-3 is on by default; these tests assert the confident path never asks the LLM.
  const decision = { enabled: true, flow: collectionsFlow(), speculation: { llm: false }, ...over };
  const behavior = new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', variables, decision }),
    model.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', decision: jev.port as DecisionPort },
  );
  return { behavior, jev, model };
}

describe('an agent routed by a flow', () => {
  it('walks the conversation state by state, with no LLM on the confident path', async () => {
    const { behavior, jev, model } = agent([
      { intent: 'promise_to_pay', slots: { ptp_when: 'tomorrow' } },
    ]);
    expect(await behavior.respond('hello?', call)).toBe(
      "Hello, I'm calling from CreditMantri. Am I speaking with Ravi Kumar?",
    );
    expect(await behavior.respond('yes', call)).toBe(
      'Your EMI of four thousand rupees could not be collected. When would you be able to make this payment?',
    );
    expect(await behavior.respond('kal kar dunga', call)).toBe(
      "Thank you. I've noted that you'll pay tomorrow. Is there anything else I can help you with?",
    );
    expect(model.requests).toHaveLength(0);
    // The phrase tier answered two of the three replies without a round trip.
    expect(jev.requests).toHaveLength(1);
    const gate = behavior.decisions.at(-1)!.result;
    expect(gate).toMatchObject({ kind: 'flow', step: { kind: 'enter', node: 'ptp_tomorrow' } });
  });

  it('replays the current node on a repeat request, with no decision', async () => {
    const { behavior, jev } = agent();
    await behavior.respond('hello?', call);
    await behavior.respond('yes', call);
    expect(await behavior.respond('Sorry?', call)).toBe(
      'Sure, let me repeat that. Your EMI of four thousand rupees could not be collected. ' +
        'When would you be able to make this payment?',
    );
    expect(jev.requests).toHaveLength(0);
  });

  it('completes with the ending node as the reason', async () => {
    const { behavior } = agent([{ intent: 'stop_calling' }]);
    behavior.beginTurn(1);
    await behavior.respond('hello?', call);
    behavior.beginTurn(2);
    const goodbye = await behavior.respond('never call me again', call);
    expect(goodbye).toBe('Understood. We will not call again. Goodbye.');
    behavior.onPlayback(receipt(goodbye, 2));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:flow:stop_calling');
  });

  it('hands a reply the flow cannot place to the LLM, staying in the same state', async () => {
    const { behavior, model } = agent([{ intent: 'other' }, { intent: 'confirmed' }]);
    await behavior.respond('hello?', call);
    expect(await behavior.respond('is this about my loan?', call)).toBe('A composed LLM answer.');
    expect(model.requests).toHaveLength(1);
    expect(await behavior.respond('yes that is me', call)).toContain('Your EMI');
  });

  it('skips a line this call cannot fill and speaks the rest of the node', async () => {
    const { behavior } = agent();
    expect(await behavior.respond('hello?', { emi: 'x' })).toBe(
      "Hello, I'm calling from CreditMantri.",
    );
  });

  it('does not route by a disabled flow', async () => {
    const { behavior, jev, model } = agent([], { enabled: false });
    expect(await behavior.respond('hello?', call)).toBe('A composed LLM answer.');
    expect(jev.requests).toHaveLength(0);
    expect(model.requests).toHaveLength(1);
  });

  it('refuses to start a flow the release check would have blocked', () => {
    expect(() => agent([], { flow: { ...collectionsFlow(), start: 'nowhere' } })).toThrow(
      FlowCompileError,
    );
  });

  it('never compiles a disabled flow, so a broken one cannot fail the call', async () => {
    const broken = { ...collectionsFlow(), start: 'nowhere' };
    const { behavior } = agent([], { enabled: false, flow: broken });
    expect(await behavior.respond('hello?', call)).toBe('A composed LLM answer.');
  });
});
