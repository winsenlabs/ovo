import { describe, expect, it } from 'vitest';
import { AgentFlow, type FlowTransition } from '@winsendotai/ovo-contracts';
import {
  FlowSession,
  UNVERIFIED_FACTS_NOTICE,
  type DecisionTurn,
  type FlowStep,
} from '../src/index.ts';
import { collectionsFlow, scriptedJev, type Scripted } from './flow-fixture.ts';

const NOW = new Date('2026-10-07T05:00:00Z');
const live = () => new AbortController().signal;

function session(script: (Scripted | Error)[] = [], over: Record<string, unknown> = {}) {
  const jev = scriptedJev(script);
  const flow = new FlowSession(AgentFlow.parse({ ...collectionsFlow(), ...over }), {
    port: jev.port,
    timeoutMs: 800,
    now: () => NOW,
  });
  return { flow, jev };
}

const turn = (input: string, history: DecisionTurn['history'] = []): DecisionTurn => ({
  input,
  history,
  variables: { full_name: 'Ravi Kumar' },
  context: 'Briefing.',
  today: 'Wednesday, 7 October 2026',
});

/** Propose and commit, as a turn that is still current does. */
async function say(flow: FlowSession, input: string, history: DecisionTurn['history'] = []) {
  const step = await flow.next(turn(input, history), live());
  flow.commit(step);
  return step;
}
const ids = (step: FlowStep) => ('lines' in step ? step.lines.map((line) => line.id) : []);

describe('a flow session (AGT-1)', () => {
  it('enters the start node on the first turn, whatever the caller said, with no decision', async () => {
    const { flow, jev } = session();
    const step = await say(flow, 'hello?');
    expect(step).toMatchObject({ kind: 'enter', node: 'greet', end: false });
    expect(ids(step)).toEqual(['intro', 'ask_identity']);
    expect(flow.state).toMatchObject({ node: 'greet', listen: 'identity', started: true });
    expect(jev.requests).toHaveLength(0);
  });

  it('resolves an authored phrase instantly and confirms identity on the verified node', async () => {
    const { flow, jev } = session();
    await say(flow, '');
    expect(flow.verified).toBe(false);
    expect(flow.gateFacts('- emi: 4,210 rupees')).toBe(UNVERIFIED_FACTS_NOTICE);
    const step = await say(flow, 'Haan ji.');
    expect(step).toMatchObject({ kind: 'enter', node: 'disclose' });
    expect(step.transition).toMatchObject({ tier: 'rule', intent: 'confirmed', confidence: 1 });
    expect(jev.requests).toHaveLength(0);
    expect(flow.verified).toBe(true);
    expect(flow.gateFacts('- emi: 4,210 rupees')).toBe('- emi: 4,210 rupees');
  });

  it('asks only the current listen set, grounded in what the agent just said', async () => {
    const { flow, jev } = session([{ intent: 'asks_purpose' }]);
    await say(flow, '');
    const step = await say(flow, 'who is this', [
      { role: 'user', content: 'hello?' },
      { role: 'assistant', content: "Hello, I'm calling from CreditMantri." },
      { role: 'assistant', content: '[Playback evidence: estimated.] Am I speaking with Ravi?' },
    ]);
    expect(step).toMatchObject({ kind: 'enter', node: 'reassure' });
    const request = jev.requests[0]!;
    expect(Object.keys((request.questions.intent as { criteria: object }).criteria)).toEqual([
      'confirmed',
      'wrong_person',
      'asks_purpose',
      'repeat',
      'stop_calling',
      'other',
    ]);
    expect(request.state).toEqual({
      caller_reply: 'who is this',
      agent_last_said: "Hello, I'm calling from CreditMantri. Am I speaking with Ravi?",
      recent_turns: [
        'caller: hello?',
        "agent: Hello, I'm calling from CreditMantri.",
        'agent: Am I speaking with Ravi?',
      ],
      today: 'Wednesday, 7 October 2026',
    });
    // Telemetry learns where the decision was asked; the model never does.
    expect(jev.traces[0]).toEqual({ flow: { node: 'greet', listen: 'identity' } });
    expect(JSON.stringify(request)).not.toContain('greet');
  });

  it('routes by a slot answered in the same request and records the disposition', async () => {
    const { flow } = session([{ intent: 'promise_to_pay', slots: { ptp_when: 'tomorrow' } }]);
    await say(flow, '');
    await say(flow, 'yes');
    const step = await say(flow, 'I will pay it tomorrow evening');
    expect(step).toMatchObject({ kind: 'enter', node: 'ptp_tomorrow' });
    expect(step.transition).toMatchObject({
      tier: 'decision',
      intent: 'promise_to_pay',
      slots: { ptp_when: 'tomorrow' },
      disposition: 'promise_to_pay:tomorrow',
      from: { node: 'disclose', listen: 'payment' },
      to: { node: 'ptp_tomorrow', listen: 'wrapup' },
      modelId: 'jev-1',
    });
  });

  it('falls back on other, low confidence and an unavailable model, without moving', async () => {
    const { flow } = session([
      { intent: 'other' },
      { intent: 'wrong_person', confidence: 0.3 },
      new Error('jev down'),
    ]);
    await say(flow, '');
    const other = await say(flow, 'what is the weather');
    const low = await say(flow, 'erm maybe');
    const down = await say(flow, 'hello?');
    expect([other, low, down].map((step) => step.transition.reason)).toEqual([
      'other',
      'low-confidence',
      'unavailable',
    ]);
    expect(other).toMatchObject({ kind: 'fallback', action: 'llm' });
    expect(down).toMatchObject({ unavailable: { reason: 'error', message: 'jev down' } });
    expect(flow.state).toMatchObject({ node: 'greet', listen: 'identity' });
  });

  it('reports a decision past its deadline as a timeout', async () => {
    const deadline = new AbortController();
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), {
      timeoutMs: 800,
      clock: { timeout: () => deadline.signal },
      port: {
        decide: (_request, options) =>
          new Promise((_, reject) =>
            options.signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      },
    });
    flow.commit((await flow.next(turn(''), live()))!);
    const pending = flow.next(turn('hmm'), live());
    deadline.abort();
    expect(await pending).toMatchObject({
      kind: 'fallback',
      unavailable: { reason: 'timeout', message: 'Decision did not answer within 800ms' },
    });
  });

  it('asks again with its own line when the flow runs without an LLM', async () => {
    const { flow } = session([{ intent: 'other' }], {
      fallback: 'clarify',
      clarify: 'repeat_prefix',
    });
    await say(flow, '');
    expect(await say(flow, 'blah')).toMatchObject({
      kind: 'fallback',
      action: 'clarify',
      line: { id: 'repeat_prefix' },
    });
  });

  it('replays the last node with the repeat prefix and stays in the same state', async () => {
    const { flow } = session();
    await say(flow, '');
    const step = await say(flow, 'Sorry?');
    expect(step.kind).toBe('repeat');
    expect(ids(step)).toEqual(['repeat_prefix', 'intro', 'ask_identity']);
    expect(flow.state).toMatchObject({ node: 'greet', listen: 'identity' });
    // A second repeat replays the node, not the prefix twice.
    expect(ids(await say(flow, 'pardon'))).toEqual(['repeat_prefix', 'intro', 'ask_identity']);
  });

  it('moves nothing until a step is committed', async () => {
    const { flow } = session();
    await say(flow, '');
    const proposed = await flow.next(turn('yes'), live());
    expect(proposed).toMatchObject({ kind: 'enter', node: 'disclose' });
    expect(flow.state).toMatchObject({ node: 'greet', verified: false });
    expect(flow.path).toHaveLength(1);
  });

  it('after the goodbye is barged into, hands the reply to the LLM or says goodbye again', async () => {
    const withLlm = session([{ intent: 'stop_calling' }]).flow;
    const jevOnly = session([{ intent: 'stop_calling' }], { fallback: 'clarify' }).flow;
    for (const flow of [withLlm, jevOnly]) {
      await say(flow, '');
      expect(await say(flow, 'never call me again')).toMatchObject({
        node: 'stop_calling',
        end: true,
      });
    }
    expect(await say(withLlm, 'wait!')).toMatchObject({
      kind: 'fallback',
      action: 'llm',
      transition: { reason: 'ended' },
    });
    expect(await say(jevOnly, 'wait!')).toMatchObject({
      kind: 'enter',
      node: 'stop_calling',
      end: true,
    });
  });

  it('lets an injected rules tier answer before the model', async () => {
    const jev = scriptedJev([]);
    const flow = new FlowSession(AgentFlow.parse(collectionsFlow()), {
      port: jev.port,
      timeoutMs: 800,
      rules: (reply, listen) =>
        listen === 'identity' && reply === 'ji bilkul' ? 'confirmed' : undefined,
    });
    flow.commit((await flow.next(turn(''), live()))!);
    expect(await flow.next(turn('ji bilkul'), live())).toMatchObject({ node: 'disclose' });
    expect(jev.requests).toHaveLength(0);
  });

  it('keeps a bounded path and tells listeners about each transition', async () => {
    const { flow } = session();
    const seen: FlowTransition[] = [];
    flow.onTransition((transition) => seen.push(transition));
    await say(flow, '');
    for (let index = 0; index < 120; index += 1) await say(flow, 'sorry');
    expect(seen).toHaveLength(121);
    expect(flow.path).toHaveLength(100);
    expect(flow.path[0]!.tier).toBe('rule');
    expect(seen[0]).toMatchObject({ tier: 'start', at: NOW.toISOString(), to: { node: 'greet' } });
  });
});

describe('rejoining after the LLM (AGT-7)', () => {
  it('resumes at a listen set the flow offers and refuses anything else', async () => {
    const { flow } = session();
    await say(flow, '');
    await say(flow, 'yes');
    expect(flow.rejoin('wrapup', false)).toBe(false);
    expect(flow.state).toMatchObject({ node: 'disclose', listen: 'wrapup' });
    expect(flow.rejoin('nowhere', false)).toBe(false);
    expect(flow.state.listen).toBe('wrapup');
    expect(flow.path.at(-1)).toMatchObject({ tier: 'llm', reason: 'invalid-resume' });
  });

  it('ends the call only when the agent lets the LLM end it', async () => {
    const { flow } = session();
    await say(flow, '');
    expect(flow.resumeOptions(false)).not.toContain('end');
    expect(flow.rejoin('end', false)).toBe(false);
    expect(flow.state.ended).toBe(false);
    expect(flow.rejoin('end', true)).toBe(true);
    expect(flow.state).toMatchObject({ ended: true, node: 'greet' });
  });

  it('cannot talk its way past identity confirmation', async () => {
    const { flow } = session();
    await say(flow, '');
    expect(flow.resumeOptions(false)).toEqual(['identity']);
    flow.rejoin('payment', false);
    expect(flow.state.listen).toBe('identity');
    await say(flow, 'yes');
    // Confirmed: the LLM goes forward from here, never back to asking who picked up.
    expect(flow.resumeOptions(true)).toEqual(['payment', 'wrapup', 'end']);
  });

  it('records an LLM turn that kept the flow where it was', async () => {
    const { flow } = session();
    await say(flow, '');
    flow.rejoin(undefined, false);
    expect(flow.path.at(-1)).toEqual({
      at: NOW.toISOString(),
      from: { node: 'greet', listen: 'identity' },
      to: { node: 'greet', listen: 'identity' },
      tier: 'llm',
    });
  });
});
