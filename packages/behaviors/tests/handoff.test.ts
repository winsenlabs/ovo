import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  CallbackRequest,
  DEFAULT_GIVE_UP,
  readSessionEvent,
  type DecisionPort,
  type EventSink,
  type InferenceReply,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, callbackDueAt, TRANSFER_DISPOSITION } from '../src/index.ts';
import {
  call,
  collect,
  execution,
  llm,
  NOW,
  receipt,
  variables,
} from './agent-call-control-fixture.ts';
import { collectionsFlow, scriptedJev, type Scripted } from './flow-fixture.ts';
import { jev, policy } from './jev-only-fixture.ts';

const phone = { kind: 'phone', e164: '+918041234567' };

function sink() {
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const port: EventSink = {
    append: async (type, payload) => {
      readSessionEvent(type, payload); // every recorded event is valid for storage
      events.push({ type, payload });
    },
  };
  return { port, events };
}

function build(
  over: Record<string, unknown>,
  options: {
    decision?: DecisionPort;
    model?: ReturnType<typeof llm> | null;
    events?: EventSink;
  } = {},
) {
  const model = options.model === null ? undefined : (options.model ?? llm());
  return new AgentBehavior(
    AgentConfig.parse({ name: 'Collections', mode: 'agent', variables, ...over }),
    model?.port,
    execution,
    {
      workspaceId: 'w-1',
      sessionId: 's-1',
      now: () => NOW,
      ...(options.decision ? { decision: options.decision } : {}),
      ...(options.events ? { events: options.events } : {}),
    },
  );
}

/** The collections flow with the POC's `human` and `cb_evening` end nodes, reached by phrase. */
function handoffFlow() {
  const flow = collectionsFlow();
  flow.lines.human = "Sure, I'm transferring you to a representative. Please hold.";
  flow.lines.cb_evening = "Sure, I'll call you back this evening.";
  flow.nodes.push(
    { id: 'human', say: ['human'], end: true, disposition: 'transfer_to_human' },
    { id: 'cb_evening', say: ['cb_evening'], end: true, disposition: 'callback:this_evening' },
  );
  flow.globalIntents.push(
    {
      key: 'human_agent',
      description: 'They ask for a person',
      phrases: ['agent please'],
      next: 'human',
    },
    { key: 'busy', description: 'They are busy', phrases: ['call me later'], next: 'cb_evening' },
  );
  return { enabled: true, questions: [], flow };
}

const flowCall = { ...call, full_name: 'Ravi Kumar', emi: 'four thousand rupees' };
const flowVariables = {
  type: 'object',
  properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
};

function flowAgent(handoff: Record<string, unknown>, script: Scripted[] = [], events?: EventSink) {
  return build(
    { variables: flowVariables, decision: handoffFlow(), handoff },
    { decision: scriptedJev(script).port as DecisionPort, ...(events ? { events } : {}) },
  );
}

/** Plays every line of a turn so a completion the turn armed settles. */
async function turn(behavior: AgentBehavior, epoch: number, input: string, vars = flowCall) {
  behavior.beginTurn(epoch);
  const said = await collect(behavior.respondStream(input, vars));
  for (const line of said) behavior.onPlayback(receipt(line, epoch));
  return said;
}

describe('flow nodes that transfer (AGT-15)', () => {
  it('speaks the node and completes as a transfer once it has played', async () => {
    const behavior = flowAgent({ transfer: { target: phone, nodes: ['human'] } });
    await turn(behavior, 1, '', { ...flowCall, inputEvent: 'opening' } as never);
    behavior.beginTurn(2);
    const said = await collect(behavior.respondStream('agent please', flowCall));
    expect(said).toEqual(["Sure, I'm transferring you to a representative. Please hold."]);
    expect(behavior.isComplete()).toBe(false);
    behavior.onPlayback(receipt(said[0]!, 2));
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('transfer:flow:human');
  });

  it('leaves an end node that is not a transfer node as a plain hang-up', async () => {
    const behavior = flowAgent({ transfer: { target: phone, nodes: ['human'] } });
    await turn(behavior, 1, '', { ...flowCall, inputEvent: 'opening' } as never);
    await turn(behavior, 2, 'call me later');
    expect(behavior.completionReason()).toBe('decision:flow:cb_evening');
  });

  it('hangs up at the same node when no transfer is configured for it', async () => {
    const behavior = flowAgent({});
    await turn(behavior, 1, '', { ...flowCall, inputEvent: 'opening' } as never);
    await turn(behavior, 2, 'agent please');
    expect(behavior.completionReason()).toBe('decision:flow:human');
  });
});

describe('callback nodes (AGT-15)', () => {
  it('records the promised callback, due at the local time in the agent timezone', async () => {
    const recorded = sink();
    const behavior = flowAgent(
      { callback: { nodes: { cb_evening: { at: '18:00' } } } },
      [],
      recorded.port,
    );
    await turn(behavior, 1, '', { ...flowCall, inputEvent: 'opening' } as never);
    await turn(behavior, 2, 'call me later');
    const callbacks = recorded.events.filter((event) => event.payload.callback);
    // NOW is 05:00 on 7 October in Asia/Kolkata; 18:00 IST is 12:30 UTC.
    expect(callbacks).toEqual([
      {
        type: 'disposition',
        payload: {
          disposition: 'callback:this_evening',
          turn: 1,
          node: 'cb_evening',
          source: 'system',
          reason: 'callback',
          callback: {
            dueAt: '2026-10-07T12:30:00.000Z',
            timezone: 'Asia/Kolkata',
            source: 'flow',
            node: 'cb_evening',
            requested: { at: '18:00', day: 'today' },
          },
        },
      },
    ]);
    expect(CallbackRequest.parse(callbacks[0]!.payload.callback)).toBeTruthy();
    expect(behavior.completionReason()).toBe('decision:flow:cb_evening');
  });

  it('records nothing for a node that is not a callback node', async () => {
    const recorded = sink();
    const behavior = flowAgent({ callback: { nodes: {} } }, [], recorded.port);
    await turn(behavior, 1, '', { ...flowCall, inputEvent: 'opening' } as never);
    await turn(behavior, 2, 'call me later');
    expect(recorded.events.some((event) => event.payload.callback)).toBe(false);
  });
});

describe('fallbacks that transfer (AGT-15)', () => {
  it('transfers when the decision model is unavailable, instead of the LLM', async () => {
    const recorded = sink();
    const model = llm();
    const behavior = build(
      {
        decision: policy(),
        handoff: { transfer: { target: phone, onDecisionUnavailable: true } },
      },
      { decision: jev(new Error('jev down')).port, model, events: recorded.port },
    );
    expect(await turn(behavior, 1, 'I will pay', call)).toEqual([
      'Please hold while I connect you to a colleague.',
    ]);
    expect(model.requests).toHaveLength(0);
    expect(behavior.completionReason()).toBe('transfer:decision:unavailable');
    expect(recorded.events.find((event) => event.type === 'disposition')?.payload).toEqual({
      disposition: TRANSFER_DISPOSITION,
      turn: 1,
      source: 'system',
      reason: 'transfer:decision:unavailable',
    });
  });

  it('keeps the LLM fallback when the unavailable trigger is off', async () => {
    const model = llm();
    const behavior = build(
      { decision: policy(), handoff: { transfer: { target: phone } } },
      { decision: jev(new Error('jev down')).port, model },
    );
    expect(await turn(behavior, 1, 'I will pay', call)).toEqual(['A composed LLM answer.']);
    expect(behavior.isComplete()).toBe(false);
  });

  it('transfers once the re-asks run out, instead of the give-up line', async () => {
    const config = (onRecoveryExhausted: boolean) => ({
      decision: policy(),
      recovery: { maxAttempts: 1 },
      handoff: {
        transfer: { target: phone, line: 'Connecting you, {{name}}.', onRecoveryExhausted },
      },
    });
    const clarify = () => jev(['pay', 0.4], ['pay', 0.4]).port;
    const transfers = build(config(true), { decision: clarify(), model: null });
    await turn(transfers, 1, 'hmm', call);
    expect(await turn(transfers, 2, 'hmm', call)).toEqual(['Connecting you, Ravi.']);
    expect(transfers.completionReason()).toBe('transfer:recovery:exhausted');
    const ends = build(config(false), { decision: clarify(), model: null });
    await turn(ends, 1, 'hmm', call);
    expect(await turn(ends, 2, 'hmm', call)).toEqual([DEFAULT_GIVE_UP]);
    expect(ends.completionReason()).toBe('recovery:exhausted');
  });

  it('rejects a transfer line with an undeclared variable when the agent is built', () => {
    expect(() =>
      build({
        decision: policy(),
        handoff: {
          transfer: { target: phone, line: 'Hold, {{nobody}}.', onRecoveryExhausted: true },
        },
      }),
    ).toThrow();
  });
});

describe('the LLM handoff tools (AGT-15)', () => {
  const tool = (toolId: string, input: Record<string, unknown> = {}): InferenceReply => ({
    kind: 'tool',
    toolId,
    input,
  });

  it('offers transfer_call and completes as a transfer after the spoken line', async () => {
    const model = llm([tool('transfer_call', { reason: 'asked for a manager' })]);
    model.port.stream = undefined;
    const recorded = sink();
    const behavior = build(
      { handoff: { transfer: { target: phone, llmTool: true } } },
      { model, events: recorded.port },
    );
    behavior.beginTurn(1);
    const said = await behavior.respond('let me talk to your manager', call);
    expect(model.requests[0]!.tools.map((offered) => offered.id)).toContain('transfer_call');
    expect(model.requests[1]!.results.at(-1)).toMatchObject({
      toolId: 'transfer_call',
      state: 'succeeded',
    });
    behavior.onPlayback(receipt(said, 1));
    expect(behavior.completionReason()).toBe('transfer:llm');
    expect(recorded.events.at(-1)?.payload).toMatchObject({
      disposition: TRANSFER_DISPOSITION,
      source: 'llm',
      reason: 'transfer:llm:asked for a manager',
    });
  });

  it('records a callback the LLM schedules and ends the call after the goodbye', async () => {
    const model = llm([tool('schedule_callback', { local_time: '10:30', day: 'tomorrow' })]);
    model.port.stream = undefined;
    const recorded = sink();
    const behavior = build(
      { handoff: { callback: { llmTool: true } } },
      {
        model,
        events: recorded.port,
      },
    );
    behavior.beginTurn(1);
    const said = await behavior.respond('call me tomorrow morning', call);
    behavior.onPlayback(receipt(said, 1));
    expect(behavior.completionReason()).toBe('llm:schedule_callback');
    expect(recorded.events.at(-1)?.payload.callback).toEqual({
      // 10:30 IST on Thursday 8 October (it is already the 7th in Kolkata).
      dueAt: '2026-10-08T05:00:00.000Z',
      timezone: 'Asia/Kolkata',
      source: 'llm',
      requested: { at: '10:30', day: 'tomorrow' },
    });
    expect(model.requests[1]!.results.at(-1)).toMatchObject({
      state: 'succeeded',
      result: { status: 'scheduled' },
    });
  });

  it('reports a callback it cannot record as a failed tool, and keeps the call open', async () => {
    const model = llm([tool('schedule_callback')]);
    model.port.stream = undefined;
    const behavior = build({ handoff: { callback: { llmTool: true } } }, { model });
    behavior.beginTurn(1);
    const said = await behavior.respond('call me later', call);
    behavior.onPlayback(receipt(said, 1));
    // A failed read tool speaks the processing failure line, as any other tool's failure does.
    expect(said).toBe(behavior.config.processing.failure);
    expect(behavior.isComplete()).toBe(false);
  });

  it('offers neither tool without the flags, so a model that calls one gets an error', async () => {
    const model = llm([tool('transfer_call')]);
    const behavior = build({ handoff: { transfer: { target: phone } } }, { model });
    await expect(behavior.respond('a person please', call)).rejects.toThrow('transfer_call');
    expect(model.requests[0]!.tools).toEqual([]);
  });
});

describe('callbackDueAt', () => {
  const now = new Date('2026-10-06T10:00:00Z'); // 15:30 in Kolkata
  it('counts a delay from now', () => {
    expect(callbackDueAt({ inMinutes: 30 }, now, 'Asia/Kolkata', 120).toISOString()).toBe(
      '2026-10-06T10:30:00.000Z',
    );
  });
  it('reads a local time today or tomorrow in the timezone', () => {
    expect(
      callbackDueAt({ at: '18:00', day: 'today' }, now, 'Asia/Kolkata', 120).toISOString(),
    ).toBe('2026-10-06T12:30:00.000Z');
    expect(
      callbackDueAt({ at: '09:00', day: 'tomorrow' }, now, 'America/New_York', 120).toISOString(),
    ).toBe('2026-10-07T13:00:00.000Z');
  });
  it('falls back to the default delay for a passed time or no time', () => {
    expect(
      callbackDueAt({ at: '09:00', day: 'today' }, now, 'Asia/Kolkata', 120).toISOString(),
    ).toBe('2026-10-06T12:00:00.000Z');
    expect(callbackDueAt(undefined, now, 'Asia/Kolkata', 60).toISOString()).toBe(
      '2026-10-06T11:00:00.000Z',
    );
  });
  it('rolls a tomorrow at the end of a month into the next month', () => {
    const late = new Date('2026-10-31T10:00:00Z');
    expect(callbackDueAt({ at: '10:00', day: 'tomorrow' }, late, 'UTC', 60).toISOString()).toBe(
      '2026-11-01T10:00:00.000Z',
    );
  });
});
