import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentFlow,
  type DecisionPort,
  type Execution,
  type InferenceReply,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior, FlowSession } from '../src/index.ts';
import { INTERRUPTED_CONTEXT } from '../src/history.ts';
import { collect, llm, receipt } from './agent-call-control-fixture.ts';
import { collectionsFlow, scriptedJev, type FlowFixture, type Scripted } from './flow-fixture.ts';

/*
 * Regressions from the first live CreditMantri calls, 2026-10-07 (call A 4e4d2228, call B
 * 8cbac365; timelines tl_A.txt and tl_B.txt). Caller words are the calls' own final transcripts.
 */

const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };
const variables = {
  type: 'object',
  properties: { full_name: { type: 'string' }, emi: { type: 'string' } },
  additionalProperties: false,
};
const call = { full_name: 'Ravi Kumar', emi: 'four thousand rupees' };
const DISCLOSE = [
  'Your EMI of four thousand rupees could not be collected.',
  'When would you be able to make this payment?',
];
const STOP = 'Understood. We will not call again. Goodbye.';

/** The fixture flow as the 2026-10-07 import ships it: mandatory disclosure, hold, a strict DNC. */
function liveFlow(change: (flow: FlowFixture) => void = () => {}): FlowFixture {
  const flow = collectionsFlow();
  flow.lines.hold_prefix = 'Sure, take your time.';
  flow.holdPrefix = 'hold_prefix';
  flow.nodes.find((node) => node.id === 'disclose')!.mandatory = ['emi'];
  flow.globalIntents.push({
    key: 'hold',
    description: 'They ask the agent to wait, or to stop talking and listen',
    phrases: ['one minute', 'wait'],
    hold: true,
  });
  flow.globalIntents.find((intent) => intent.key === 'stop_calling')!.threshold = 0.8;
  change(flow);
  return flow;
}

function agent(
  script: Scripted[] = [],
  options: {
    flow?: FlowFixture;
    replies?: (InferenceReply | InferenceStreamEvent[])[];
    config?: Record<string, unknown>;
  } = {},
) {
  const jev = scriptedJev(script);
  const model = llm(options.replies ?? []);
  const decision = {
    enabled: true,
    flow: options.flow ?? liveFlow(),
    speculation: { llm: false },
  };
  const behavior = new AgentBehavior(
    AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      variables,
      decision,
      ...options.config,
    }),
    model.port,
    execution,
    { workspaceId: 'w-1', sessionId: 's-1', decision: jev.port as DecisionPort },
  );
  // One engine turn: a new playback epoch, the reply, then each line's receipt in order.
  let epoch = 0;
  const turn = async (
    text: string,
    played: 'completed' | 'interrupted' | ('completed' | 'interrupted')[] = 'completed',
    extra: Record<string, unknown> = {},
  ) => {
    behavior.beginTurn(++epoch);
    const said = await collect(behavior.respondStream(text, { ...call, ...extra }));
    const states = Array.isArray(played) ? played : said.map(() => played);
    let cut = false;
    for (const [index, line] of said.entries()) {
      const state = states[index] ?? 'interrupted';
      // Lines that played came in first; a barge-in cancels the turn, then the cut lines report.
      if (state === 'interrupted' && !cut) {
        cut = true;
        behavior.cancel('turn interrupted');
      }
      behavior.onPlayback(receipt(line, epoch, state));
    }
    return said;
  };
  return { behavior, jev, model, turn };
}

describe('a terminal node is final (P4)', () => {
  it('says the goodbye once more when it was cut before any of it played, then ends', async () => {
    // Call B: "Ananya, please stop." → stop_calling → goodbye cut 0.7 s in → the LLM rejoined at
    // identity and the loan was disclosed again.
    const { behavior, jev, model, turn } = agent([{ intent: 'stop_calling', confidence: 0.92 }]);
    await turn('hello?');
    expect(await turn('Stop calling me, never call this number again.', 'interrupted')).toEqual([
      STOP,
    ]);
    expect(behavior.isComplete()).toBe(false);
    expect(await turn('Okay, so listen to me one by one.', 'interrupted')).toEqual([STOP]);
    // Cut again: the call is over all the same.
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:flow:stop_calling');
    expect(jev.requests).toHaveLength(1);
    expect(model.requests).toHaveLength(0);
    expect(behavior.flow!.state).toMatchObject({ node: 'stop_calling', ended: true });
  });

  it('ends on the cut when the caller had heard part of the goodbye', async () => {
    const flow = liveFlow((f) => {
      f.nodes.find((node) => node.id === 'stop_calling')!.say = ['stop_calling', 'goodbye'];
    });
    const { behavior, turn } = agent([{ intent: 'stop_calling', confidence: 0.92 }], { flow });
    await turn('hello?');
    await turn('never call me again', ['completed', 'interrupted']);
    // Complete on the receipt itself, so the engine can hang up without waiting for a next turn.
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:flow:stop_calling');
    expect(await turn('What is your name?')).toEqual([]);
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:flow:stop_calling');
  });

  it('closes on a silence after a cut goodbye instead of prompting the caller', async () => {
    const flow = liveFlow();
    const { behavior, turn } = agent([{ intent: 'stop_calling', confidence: 0.92 }], {
      flow,
      config: { idle: { prompts: ['Hello? Can you hear me?'], finalLine: 'Goodbye.' } },
    });
    await turn('hello?');
    await turn('never call me again', 'interrupted');
    expect(await turn('', 'completed', { inputEvent: 'idle' })).toEqual([STOP]);
    expect(behavior.isComplete()).toBe(true);
  });

  it('never hands an ended flow back to the LLM, and records one disposition', async () => {
    const flow = new FlowSession(AgentFlow.parse(liveFlow()), { timeoutMs: 800 });
    flow.commit(flow.begin()!);
    flow.commit({
      kind: 'enter',
      node: 'stop_calling',
      lines: [],
      end: true,
      transition: {
        at: '',
        from: {},
        to: { node: 'stop_calling' },
        tier: 'decision',
        disposition: 'do_not_call',
      },
    });
    expect(flow.resumeOptions(false)).toEqual([]);
    expect(flow.resumeOptions(true)).toEqual(['end']);
    expect(flow.rejoin('identity', true)).toBe(false);
    expect(flow.state).toMatchObject({ node: 'stop_calling', ended: true });
    expect(flow.path.filter((transition) => transition.disposition)).toHaveLength(1);
  });
});

describe('mandatory lines must be heard (P5)', () => {
  it('says the node again from the unheard line instead of answering an unheard question', async () => {
    // Call B: the disclosure was cut 0.46 s in, yet the node counted as verified and delivered.
    const { behavior, jev, model, turn } = agent([
      { intent: 'confirmed', confidence: 0.73 },
      { intent: 'other', confidence: 0.44 },
    ]);
    await turn('hello?');
    expect(await turn('Yes, sir. It takes a lot of time.', 'interrupted')).toEqual(DISCLOSE);
    expect(behavior.flow!.verified).toBe(false);
    expect(behavior.flow!.unheardLines).toEqual(['emi']);
    // "It is not." answered a question the caller never heard: the disclosure comes first.
    expect(await turn('It is not.')).toEqual(DISCLOSE);
    expect(jev.requests).toHaveLength(2);
    expect(model.requests).toHaveLength(0);
    expect(behavior.flow!.path.at(-1)).toMatchObject({ reason: 'unheard', intent: 'other' });
    // Played in full: identity counts as confirmed and the call facts reach the LLM.
    expect(behavior.flow!.verified).toBe(true);
    expect(behavior.flow!.disclosed).toEqual([DISCLOSE[0]]);
  });

  it('leaves the state at once for a global intent, unheard lines or not', async () => {
    const { behavior, turn } = agent([{ intent: 'stop_calling', confidence: 0.95 }]);
    await turn('hello?');
    await turn('yes', 'interrupted');
    expect(await turn('Stop calling me, do not call this number again.')).toEqual([STOP]);
    expect(behavior.flow!.path.at(-1)).toMatchObject({
      to: { node: 'stop_calling' },
      unheardLines: ['emi'],
    });
  });

  it('says it again twice at most, then moves on and records what went unheard', async () => {
    const { behavior, model, turn } = agent([
      { intent: 'other' },
      { intent: 'other' },
      { intent: 'other' },
    ]);
    await turn('hello?');
    await turn('yes', 'interrupted');
    expect(await turn('hello?', 'interrupted')).toEqual(DISCLOSE);
    expect(await turn('hello?', 'interrupted')).toEqual(DISCLOSE);
    expect(await turn('what is this')).toEqual(['A composed LLM answer.']);
    expect(model.requests).toHaveLength(1);
    expect(behavior.flow!.path.at(-2)).toMatchObject({ tier: 'fallback', unheardLines: ['emi'] });
    expect(behavior.flow!.verified).toBe(true);
  });

  it('says the recording disclosure again before the next reply when it was cut', async () => {
    const disclosure = 'This call is recorded for quality purposes.';
    const { turn } = agent([], {
      config: { compliance: { disclosure: { text: disclosure } } },
    });
    const opening = await turn('', ['interrupted'], { inputEvent: 'opening' });
    expect(opening[0]).toBe(disclosure);
    expect((await turn('who is this?', 'completed'))[0]).toBe(disclosure);
    // Heard in full now: the next reply goes straight to its answer.
    expect(await turn('Haan ji.')).toEqual(DISCLOSE);
  });
});

describe('repeat says what the agent last said, hold asks the question again (P6)', () => {
  it('replays the LLM reply with the number, not the node the call is in', async () => {
    // Call A: "Can you repeat the number?" got the relief line six times; the number was the LLM's.
    const helpline = 'You can call us on 1800 123 4567.';
    const { model, turn } = agent(
      [{ intent: 'other' }, { intent: 'repeat', confidence: 0.99 }, { intent: 'repeat' }],
      { replies: [{ kind: 'text', text: helpline }] },
    );
    await turn('hello?');
    await turn('yes');
    expect(await turn('Where are you calling from again?')).toEqual([helpline]);
    expect(await turn('Can you repeat the number?')).toEqual([
      'Sure, let me repeat that.',
      helpline,
    ]);
    // A second repeat replays the same reply, never the prefix twice.
    expect(await turn('repeat the number')).toEqual(['Sure, let me repeat that.', helpline]);
    expect(model.requests).toHaveLength(1);
  });

  it('asks the current question again on "one minute", without moving or asking the LLM', async () => {
    const { behavior, jev, model, turn } = agent();
    await turn('hello?');
    await turn('yes');
    expect(await turn('One minute.')).toEqual([
      'Sure, take your time.',
      'When would you be able to make this payment?',
    ]);
    expect(behavior.flow!.state).toMatchObject({ node: 'disclose', listen: 'payment' });
    expect(jev.requests).toHaveLength(0);
    expect(model.requests).toHaveLength(0);
  });

  it('does not list a caller who said "please stop" as do-not-call (P10)', async () => {
    // Call B: "Ananya, please stop." was stop_calling at 0.60 and the call recorded do-not-call.
    const { behavior, model, turn } = agent([{ intent: 'stop_calling', confidence: 0.6 }]);
    await turn('hello?');
    await turn('yes');
    expect(await turn('Ananya, please stop.')).toEqual(['A composed LLM answer.']);
    expect(model.requests).toHaveLength(1);
    expect(behavior.flow!.state.ended).toBe(false);
    expect(behavior.flow!.path.some((transition) => transition.disposition)).toBe(false);
  });
});

describe('internal notes never reach the caller (P7)', () => {
  it('strips a bracketed note the model copied, and tells it of the cut in its instructions', async () => {
    // Call A at 13:02:56: the caller heard "[The response was interrupted." read out.
    const copied: InferenceStreamEvent[] = [
      { kind: 'text-delta', delta: '[The response was interrupted. ' },
      { kind: 'text-delta', delta: 'Do not assume any unconfirmed words were heard.] ' },
      { kind: 'text-delta', delta: 'When can you pay?' },
      { kind: 'finish' },
    ];
    const { model, turn } = agent([{ intent: 'other' }, { intent: 'other' }], {
      replies: [{ kind: 'text', text: 'Sure.' }, copied],
    });
    await turn('hello?');
    await turn('yes');
    await turn('It is not.', 'interrupted');
    expect(await turn('Hello?')).toEqual(['When can you pay?']);
    const request = model.requests.at(-1)!;
    expect(JSON.stringify(request.history)).not.toContain('interrupted');
    expect(request.context).toContain(INTERRUPTED_CONTEXT);
  });
});

describe('no recoverable inference error ends the call (P8)', () => {
  it('answers a resume_flow with no reply and keeps the call open', async () => {
    const { behavior, turn } = agent([{ intent: 'other' }], {
      replies: [{ kind: 'tool', toolId: 'resume_flow', input: { resume_at: 'wrapup' } }],
    });
    await turn('hello?');
    await turn('yes');
    expect(await turn('I, I was-')).toEqual([behavior.config.uncertainty]);
    expect(behavior.flow!.state.listen).toBe('wrapup');
    expect(behavior.isComplete()).toBe(false);
  });

  // A provider failure used to escape respondStream; the engine logs turn_failed and ends the call
  // with error:turn.
  for (const failing of ['stream', 'generate'] as const)
    it(`answers a provider failure in ${failing} with the uncertainty line and stays put`, async () => {
      const { behavior, model, turn } = agent([{ intent: 'other' }, { intent: 'other' }]);
      if (failing === 'stream')
        model.port.stream = async function* () {
          yield* [];
          throw new Error('upstream 503');
        };
      else {
        delete (model.port as { stream?: unknown }).stream;
        model.port.generate = async () => {
          throw new Error('upstream 503');
        };
      }
      await turn('hello?');
      await turn('yes');
      const before = { ...behavior.flow!.state };
      await expect(turn('what product is this?')).resolves.toEqual([behavior.config.uncertainty]);
      expect(behavior.flow!.state).toEqual(before);
      expect(behavior.isComplete()).toBe(false);
      expect(behavior.toolErrors.at(-1)).toMatchObject({
        kind: 'inference',
        message: 'upstream 503',
      });
      // Said twice running, the line becomes the clarification (P10).
      await expect(turn('which product?')).resolves.toEqual([behavior.config.clarification]);
      expect(behavior.isComplete()).toBe(false);
    });

  it('lets a respond caller see a provider failure, so a budget stop still stops it', async () => {
    const { behavior, model, turn } = agent([{ intent: 'other' }]);
    model.port.generate = async () => {
      throw new Error('Provider evaluation stopped: evaluation-budget-exhausted');
    };
    await turn('hello?');
    await turn('yes');
    behavior.beginTurn(99);
    await expect(behavior.respond('what product is this?', call)).rejects.toThrow(
      'evaluation-budget-exhausted',
    );
  });

  it('keeps the provider failure of a superseded turn out of the reply', async () => {
    const { behavior, model, turn } = agent([{ intent: 'other' }]);
    model.port.stream = async function* () {
      yield* [];
      behavior.cancel('turn interrupted');
      throw new Error('upstream 503');
    };
    await turn('hello?');
    await turn('yes');
    await expect(turn('what product is this?')).rejects.toThrow('upstream 503');
    expect(behavior.toolErrors).toEqual([]);
  });
});

describe('an opt-out is final (P4)', () => {
  const optOut = { compliance: { optOut: { enabled: true } } };
  const CLOSING = "Understood. We won't call this number again. Thank you, goodbye.";

  it('closes the call when the caller cut the closing line, never disclosing the loan', async () => {
    // Call B by another route: the opt-out rule catches "stop calling me" before the flow does.
    const { behavior, jev, model, turn } = agent([], { config: optOut });
    await turn('hello?');
    const asked = [jev.requests.length, model.requests.length];
    expect(await turn('stop calling me', 'interrupted')).toEqual([CLOSING]);
    expect(behavior.isComplete()).toBe(false);
    expect(await turn('yes I am Ravi Kumar')).toEqual([CLOSING]);
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('opt_out');
    expect(behavior.optedOut).toBe(true);
    expect(behavior.flow!.state.verified).toBe(false);
    expect([jev.requests.length, model.requests.length]).toEqual(asked);
  });

  it('ends on a second cut, and on a silence, without asking anyone', async () => {
    const { behavior, turn } = agent([], { config: optOut });
    await turn('hello?');
    await turn('stop calling me', 'interrupted');
    expect(await turn('Hello? Hello?', 'interrupted')).toEqual([CLOSING]);
    expect(behavior.isComplete()).toBe(true);

    const idle = agent([], {
      config: { ...optOut, idle: { prompts: ['Hello? Can you hear me?'], finalLine: 'Goodbye.' } },
    });
    await idle.turn('hello?');
    await idle.turn('stop calling me', 'interrupted');
    expect(await idle.turn('', 'completed', { inputEvent: 'idle' })).toEqual([CLOSING]);
    expect(idle.behavior.isComplete()).toBe(true);
    expect(idle.behavior.completionReason()).toBe('opt_out');
  });
});

describe('the LLM knows what the caller has been told (P10)', () => {
  it('lists the disclosure the caller heard and steers off-topic talk back', async () => {
    const { model, turn } = agent([{ intent: 'other' }]);
    await turn('hello?');
    await turn('yes');
    await turn("What's the product? You didn't tell me.");
    const context = model.requests[0]!.context;
    expect(context).toContain('has been told why you are calling');
    expect(context).toContain(`- ${DISCLOSE[0]}`);
    expect(context).toContain('Keep to the purpose of this call.');
  });
});
