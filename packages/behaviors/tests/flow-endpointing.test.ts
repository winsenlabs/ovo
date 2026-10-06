import { describe, expect, it } from 'vitest';
import { AgentFlow, type SttConfigurationUpdate } from '@winsendotai/ovo-contracts';
import { followFlowEndpointing } from '../src/flow-endpointing.ts';
import { FlowSession, type DecisionTurn } from '../src/index.ts';
import { collectionsFlow, scriptedJev, type FlowFixture, type Scripted } from './flow-fixture.ts';

// Wave 4 request 5: nothing emitted `stt.configure`, so the STT ended every turn the same way
// whether the agent had asked a yes/no question or for a date.

const live = () => new AbortController().signal;
const turn = (input: string): DecisionTurn => ({
  input,
  history: [],
  variables: { full_name: 'Ravi Kumar', emi: '4,210 rupees' },
  context: 'Briefing.',
  today: 'Wednesday, 7 October 2026',
});

function presets(over: (flow: FlowFixture) => void, script: Scripted[] = []) {
  const authored = collectionsFlow();
  over(authored);
  const flow = new FlowSession(AgentFlow.parse(authored), {
    port: scriptedJev(script).port,
    timeoutMs: 800,
  });
  const sent: SttConfigurationUpdate[] = [];
  followFlowEndpointing(flow, (update) => sent.push(update));
  const say = async (input: string) => {
    const step = await flow.next(turn(input), live());
    flow.commit(step);
    return step;
  };
  return { flow, sent, say };
}

const listen = (flow: FlowFixture, id: string) => flow.listens.find((item) => item.id === id)!;
const node = (flow: FlowFixture, id: string) =>
  flow.nodes.find((item) => item.id === id)! as FlowFixture['nodes'][number] & {
    endpointing?: string;
  };

describe('flow endpointing per state (stt.configure)', () => {
  it('sends the listen set preset on entering each state, and nothing while it is unchanged', async () => {
    const { sent, say } = presets((flow) => {
      Object.assign(listen(flow, 'identity'), { endpointing: 'fast' });
      Object.assign(listen(flow, 'payment'), { endpointing: 'patient' });
    });
    await say('hello?'); // greet → identity
    expect(sent).toEqual([{ endpointing: 'fast' }]);
    await say('sorry'); // repeat: same state
    expect(sent).toHaveLength(1);
    await say('haan ji'); // disclose → payment
    expect(sent).toEqual([{ endpointing: 'fast' }, { endpointing: 'patient' }]);
  });

  it("lets a node override its listen set, falls back to the flow's, and sends nothing unset", async () => {
    const { sent, say } = presets((flow) => {
      Object.assign(listen(flow, 'identity'), { endpointing: 'fast' });
      Object.assign(node(flow, 'reassure'), { endpointing: 'balanced' });
    });
    await say('hello?');
    await say('why are you calling'); // no phrase; the scripted decision is empty → fallback
    expect(sent).toEqual([{ endpointing: 'fast' }]);

    const withDefault = presets(
      (flow) => {
        Object.assign(node(flow, 'reassure'), { endpointing: 'balanced' });
        Object.assign(flow, { endpointing: 'patient' });
      },
      [{ intent: 'asks_purpose', confidence: 0.9 }],
    );
    await withDefault.say('hello?');
    await withDefault.say('who is this');
    await withDefault.say('haan ji');
    expect(withDefault.sent).toEqual([
      { endpointing: 'patient' },
      { endpointing: 'balanced' },
      { endpointing: 'patient' },
    ]);

    const unset = presets(() => undefined);
    await unset.say('hello?');
    await unset.say('haan ji');
    expect(unset.sent).toEqual([]);
  });

  it("follows the LLM's resume point, where that listen set decides over the node", async () => {
    const { flow, sent, say } = presets((authored) => {
      Object.assign(node(authored, 'greet'), { endpointing: 'balanced' });
      Object.assign(listen(authored, 'payment'), { endpointing: 'patient' });
      // No identity gate, so the LLM may resume at any listen set.
      node(authored, 'disclose').verified = false;
    });
    await say('hello?');
    expect(sent).toEqual([{ endpointing: 'balanced' }]);
    flow.rejoin('payment', false);
    expect(flow.state).toMatchObject({ node: 'greet', listen: 'payment' });
    expect(sent).toEqual([{ endpointing: 'balanced' }, { endpointing: 'patient' }]);
  });

  it('rejects an unknown preset in the authored flow', () => {
    const authored = collectionsFlow();
    Object.assign(listen(authored, 'identity'), { endpointing: 'eager' });
    expect(AgentFlow.safeParse(authored).success).toBe(false);
    expect(AgentFlow.safeParse({ ...collectionsFlow(), endpointing: 'fast' }).success).toBe(true);
  });
});
