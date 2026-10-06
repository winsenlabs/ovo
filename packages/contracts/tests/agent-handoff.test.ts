import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  agentHandoffLines,
  CallbackRequest,
  DEFAULT_TRANSFER_LINE,
  SCHEDULE_CALLBACK_TOOL_ID,
  TRANSFER_CALL_TOOL_ID,
} from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';

const agent = (over: Record<string, unknown>) =>
  AgentConfig.safeParse({ name: 'Collections', mode: 'agent', ...over });

/** The collections flow with the POC's `human` and `cb_evening` end nodes. */
function flowWithHandoffNodes() {
  const flow = collectionsFlow();
  flow.lines.human = "Sure, I'm transferring you to a representative. Please hold.";
  flow.lines.cb_evening = "Sure, I'll call you back this evening.";
  flow.nodes.push(
    { id: 'human', say: ['human'], end: true, disposition: 'transfer_to_human' },
    { id: 'cb_evening', say: ['cb_evening'], end: true, disposition: 'callback:this_evening' },
  );
  return { enabled: true, questions: [], flow };
}

const phone = { kind: 'phone', e164: '+918041234567' };

describe('agent handoff (AGT-15)', () => {
  it('parses a transfer and a callback policy with every trigger off by default', () => {
    const parsed = agent({ handoff: { transfer: { target: phone }, callback: {} } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.handoff).toEqual({
      transfer: {
        target: phone,
        line: DEFAULT_TRANSFER_LINE,
        nodes: [],
        onDecisionUnavailable: false,
        onRecoveryExhausted: false,
        llmTool: false,
      },
      callback: { nodes: {}, defaultDelayMinutes: 120, llmTool: false },
    });
  });

  it('accepts flow end nodes that transfer and nodes that promise a callback', () => {
    const parsed = agent({
      decision: flowWithHandoffNodes(),
      handoff: {
        transfer: { target: { kind: 'queue', name: 'collections' }, nodes: ['human'] },
        callback: { nodes: { cb_evening: { at: '18:00' } } },
      },
    });
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.data?.handoff?.callback?.nodes.cb_evening).toEqual({ at: '18:00', day: 'today' });
  });

  it('rejects transfer and callback nodes the flow does not have', () => {
    const parsed = agent({
      decision: flowWithHandoffNodes(),
      handoff: {
        transfer: { target: phone, nodes: ['nobody'] },
        callback: { nodes: { later: { inMinutes: 30 } } },
      },
    });
    expect(parsed.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [['handoff', 'transfer', 'nodes', 0], 'Transfer node nobody is not a flow node'],
      [['handoff', 'callback', 'nodes', 'later'], 'Callback node later is not a flow node'],
    ]);
  });

  it('requires a transfer node to end the call', () => {
    const parsed = agent({
      decision: flowWithHandoffNodes(),
      handoff: { transfer: { target: phone, nodes: ['greet'] } },
    });
    expect(parsed.error?.issues[0]?.message).toBe(
      'Transfer node greet must end the call (end: true)',
    );
  });

  it('rejects an invalid E.164 target and an unknown target kind', () => {
    expect(
      agent({ handoff: { transfer: { target: { kind: 'phone', e164: '080' } } } }).success,
    ).toBe(false);
    expect(agent({ handoff: { transfer: { target: { kind: 'sip', uri: 'x' } } } }).success).toBe(
      false,
    );
  });

  it('reserves the LLM tool ids only when the tools are offered', () => {
    const tool = (id: string) => ({
      id,
      description: 'An authored tool',
      connector: 'native',
      inputSchema: { type: 'object' },
      effect: 'read',
    });
    const handoff = {
      transfer: { target: phone, llmTool: true },
      callback: { llmTool: true },
    };
    for (const id of [TRANSFER_CALL_TOOL_ID, SCHEDULE_CALLBACK_TOOL_ID]) {
      expect(agent({ tools: [tool(id)], handoff }).success).toBe(false);
      expect(agent({ tools: [tool(id)], handoff: {} }).success).toBe(true);
    }
  });

  it.each(['handoff', 'reply'])('rejects %s outside agent mode', (field) => {
    const value = { handoff: {}, reply: { minFirstWords: 2 } }[field];
    const parsed = AgentConfig.safeParse({ name: 'A', mode: 'faq', [field]: value });
    expect(parsed.error?.issues[0]?.path).toEqual([field]);
  });

  it('lists the transfer line only when a fallback can speak it', () => {
    const target = { kind: 'phone' as const, e164: '+918041234567' };
    const transfer = {
      target,
      line: 'Connecting you now.',
      nodes: [],
      onDecisionUnavailable: false,
      onRecoveryExhausted: false,
      llmTool: true,
    };
    expect(agentHandoffLines({ handoff: { transfer } })).toEqual([]);
    expect(
      agentHandoffLines({ handoff: { transfer: { ...transfer, onRecoveryExhausted: true } } }),
    ).toEqual([{ field: 'handoff.transfer.line', text: 'Connecting you now.' }]);
  });

  it('bounds the callback request recorded on a disposition', () => {
    const request = {
      dueAt: '2026-10-06T18:00:00+05:30',
      timezone: 'Asia/Kolkata',
      source: 'flow',
      node: 'cb_evening',
      requested: { at: '18:00', day: 'today' },
    };
    expect(CallbackRequest.parse(request)).toEqual(request);
    expect(CallbackRequest.safeParse({ ...request, dueAt: 'tonight' }).success).toBe(false);
  });
});

describe('reply pacing (LAT-9)', () => {
  it('accepts a per-agent first-segment word floor within bounds', () => {
    expect(agent({ reply: { minFirstWords: 0 } }).data?.reply).toEqual({ minFirstWords: 0 });
    expect(agent({ reply: { minFirstWords: 13 } }).success).toBe(false);
    expect(agent({ reply: { minFirstWords: 2.5 } }).success).toBe(false);
  });
});
