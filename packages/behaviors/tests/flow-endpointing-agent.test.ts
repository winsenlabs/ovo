import { describe, expect, it } from 'vitest';
import { AgentConfig, type BehaviorEvent, type DecisionPort } from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../src/index.ts';
import { collect, execution, llm } from './agent-call-control-fixture.ts';
import { collectionsFlow, scriptedJev } from './flow-fixture.ts';

const call = { full_name: 'Ravi Kumar', emi: 'four thousand rupees' };

// Wave 4 request 5: the flow's per-state endpointing reaches the engine as `stt.configure`.
describe('a flow agent retunes STT endpointing per state', () => {
  it('emits stt.configure when the call enters a state with a different preset', async () => {
    const flow = collectionsFlow();
    Object.assign(
      flow.listens.find((listen) => listen.id === 'identity')!,
      {
        endpointing: 'fast',
      },
    );
    Object.assign(flow, { endpointing: 'patient' });
    const behavior = new AgentBehavior(
      AgentConfig.parse({
        name: 'Collections',
        mode: 'agent',
        variables: {
          type: 'object',
          properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
        },
        decision: { enabled: true, flow },
      }),
      llm([]).port,
      execution,
      { workspaceId: 'w-1', sessionId: 's-1', decision: scriptedJev([]).port as DecisionPort },
    );
    const events: BehaviorEvent[] = [];
    behavior.subscribe?.((event) => events.push(event));
    await collect(behavior.respondStream('', { ...call, inputEvent: 'opening' }));
    await collect(behavior.respondStream('haan ji', call));
    expect(events.filter((event) => event.type === 'stt.configure')).toEqual([
      { type: 'stt.configure', update: { endpointing: 'fast' } },
      { type: 'stt.configure', update: { endpointing: 'patient' } },
    ]);
  });
});
