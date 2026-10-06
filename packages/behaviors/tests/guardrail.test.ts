import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentGuardrailPolicy,
  GUARDRAIL_CHECKS,
  readSessionEvent,
  type GuardrailPayload,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { findClaims } from '../src/guardrail-detect.ts';
import {
  agentGuardrailInput,
  GuardrailMetrics,
  ReplyGuardrail,
  type ReplyGuardrailInput,
} from '../src/guardrail.ts';
import { streamAgentReply } from '../src/agent-stream.ts';
import { runPreReplySteps } from '../src/agent-pre-reply.ts';
import { AgentTurnLog } from '../src/agent-turn-log.ts';

const ALL = new Set(GUARDRAIL_CHECKS);
const claims = (text: string) =>
  findClaims(text, ALL).map((claim) => [claim.kind, claim.text, claim.keys[0]]);

describe('guardrail detection', () => {
  it('reads amounts in digits, Indian grouping, scale words and spelled out', () => {
    expect(claims('Your dues are ₹1,25,000 and the EMI is Rs. 4,850.00 only.')).toEqual([
      ['amount', '1,25,000', 'num:125000'],
      ['amount', '4,850.00', 'num:4850'],
    ]);
    expect(claims('Pay 2 lakh now, or 1.5 crore later, or 5k today.')).toEqual([
      ['amount', '2 lakh', 'num:200000'],
      ['amount', '1.5 crore', 'num:15000000'],
      ['number', '5k', 'num:5000'],
    ]);
    expect(claims('That is four thousand eight hundred and fifty rupees.')).toEqual([
      ['amount', 'four thousand eight hundred and fifty', 'num:4850'],
    ]);
    expect(claims('One moment, I have two options for you.')).toEqual([]);
    expect(claims('You can get 10% off, or twenty percent.')).toEqual([
      ['percent', '10', 'pct:10'],
      ['percent', 'twenty', 'pct:20'],
    ]);
  });

  it('reads dates without reading their numbers again, and bare numbers from 10', () => {
    expect(claims('Please pay by 15th March 2026, or on 2026-03-20, or 21/03/2026.')).toEqual([
      ['date', '2026-03-20', 'date:03-20'],
      ['date', '21/03/2026', 'date:03-21'],
      ['date', '15th March 2026', 'date:03-15'],
    ]);
    expect(claims('Call 1800 209 1234 within 48 hours, in 2 days.')).toEqual([
      ['number', '1800', 'num:1800'],
      ['number', '209', 'num:209'],
      ['number', '1234', 'num:1234'],
      ['number', '48', 'num:48'],
    ]);
  });

  it('reads concession terms but not refusals', () => {
    expect(claims('I can offer a discount and waive the late fee.')).toEqual([
      ['offer', 'discount', 'offer:discount'],
      ['offer', 'waive', 'offer:waiver'],
    ]);
    expect(claims('I cannot offer any discount or waiver on this.')).toEqual([]);
    expect(claims('We can reduce your penalty amount with a one-time Settlement.')).toEqual([
      ['offer', 'Settlement', 'offer:settlement'],
      ['offer', 'reduce your penalty', 'offer:reduction'],
    ]);
  });
});

const config = AgentConfig.parse({
  name: 'Collections',
  mode: 'agent',
  context: 'You collect overdue EMIs for Acme Finance. Never offer a waiver or discount.',
  variables: {
    type: 'object',
    properties: {
      outstanding: { type: 'number', 'x-ovo-currency': 'INR', 'x-ovo-format': 'currency' },
      due_date: { type: 'string', format: 'date' },
    },
  },
  uncertainty: 'Let me check that and get back to you.',
});
const variables = { outstanding: 4850, due_date: '2026-10-15' };
const facts =
  '- outstanding: ₹4,850.00\n- due_date: 15 October 2026\n- today: Tuesday, 6 October 2026';

function guardrail(
  policy: Partial<AgentGuardrailPolicy>,
  extra: Partial<ReplyGuardrailInput> = {},
) {
  const events: GuardrailPayload[] = [];
  const metrics = new GuardrailMetrics();
  const input: ReplyGuardrailInput = {
    policy: AgentGuardrailPolicy.parse(policy),
    fallback: config.uncertainty,
    record: (event) => events.push(event),
    metrics,
    ...extra,
  };
  return { input, events, metrics };
}

describe('ReplyGuardrail', () => {
  it('passes declared values in any spelling and flags invented ones without changing speech', () => {
    const { input, events, metrics } = guardrail({ mode: 'flag' });
    const guard = new ReplyGuardrail(input, [config.context, facts], variables, 3);
    expect(guard.check('Your outstanding is 4850 rupees, due on October 15.')).toBe(
      'Your outstanding is 4850 rupees, due on October 15.',
    );
    expect(
      guard.check('Pay four thousand eight hundred fifty rupees by 15/10/2026.'),
    ).toBeDefined();
    expect(guard.check('Today is 6 October.')).toBeDefined();
    expect(events).toEqual([]);
    expect(guard.check('If you pay ₹3,000 by 20 October I will waive the rest.')).toBe(
      'If you pay ₹3,000 by 20 October I will waive the rest.',
    );
    expect(events).toEqual([
      {
        turn: 3,
        action: 'flagged',
        findings: [
          { kind: 'date', text: '20 October' },
          { kind: 'amount', text: '3,000' },
          { kind: 'offer', text: 'waive' },
        ],
        checkUs: expect.any(Number),
      },
    ]);
    expect(readSessionEvent('guardrail', events[0]!).type).toBe('guardrail');
    expect(metrics.snapshot()).toMatchObject({ segments: 4, flagged: 1, blocked: 0 });
  });

  it('blocks with the safe line, then drops the rest of that reply', () => {
    const { input, events, metrics } = guardrail({ mode: 'block', safeLine: 'One moment please.' });
    const guard = new ReplyGuardrail(input, [config.context, facts], variables, 1);
    expect(guard.check('Sure.')).toBe('Sure.');
    expect(guard.check('You can settle for ₹2,000 today.')).toBe('One moment please.');
    expect(guard.check('Your outstanding is ₹4,850.')).toBeUndefined();
    expect(events.map((event) => event.action)).toEqual(['blocked']);
    expect(metrics.snapshot()).toMatchObject({ segments: 2, blocked: 1, dropped: 1 });
    const fallback = guardrail({ mode: 'block' });
    expect(new ReplyGuardrail(fallback.input, [], {}, 1).check('That is 25 percent off.')).toBe(
      config.uncertainty,
    );
  });

  it('allows the policy list, only the checks it names, and values that arrive mid-turn', () => {
    const results: unknown[] = [];
    const { input, events } = guardrail(
      { mode: 'flag', checks: ['amount'], allow: ['Helpline 1800 209 1234'] },
      { values: () => results },
    );
    const guard = new ReplyGuardrail(input, [], {}, 1);
    guard.check('Call 1800 209 1234 or 99887 within 48 hours; a discount applies.');
    expect(events).toEqual([]);
    guard.check('Your balance is ₹12,345.');
    expect(events).toHaveLength(1);
    results.push({ balance: { amount: 12345, currency: 'INR' } });
    guard.check('Your balance is ₹12,345.');
    expect(events).toHaveLength(1);
  });

  it('lets an agent state built-in dates and tool results, and records verdicts on its sink', () => {
    const appended: [string, Record<string, unknown>][] = [];
    const results: { result: unknown }[] = [];
    const input = agentGuardrailInput(
      AgentGuardrailPolicy.parse({ mode: 'flag' }),
      {
        config,
        now: () => new Date('2026-10-06T06:00:00Z'),
        events: { append: async (type, payload) => void appended.push([type, payload]) },
      },
      results as never,
      new GuardrailMetrics(),
    );
    const guard = new ReplyGuardrail(input, [], {}, 2);
    expect(guard.check('Can you pay by 7 October or 13 October?')).toBeDefined();
    expect(appended).toEqual([]);
    guard.check('Your balance is ₹9,999.');
    results.push({ result: { balance: 9999 } });
    guard.check('Your balance is ₹9,999.');
    expect(appended).toEqual([
      [
        'guardrail',
        expect.objectContaining({
          turn: 2,
          action: 'flagged',
          findings: [{ kind: 'amount', text: '9,999' }],
        }),
      ],
    ]);
  });

  it('checks a sentence in well under a millisecond once the call text is parsed', () => {
    const context = `${config.context}\n${'Acme Finance serves customers across India. '.repeat(250)}`;
    const { input } = guardrail({ mode: 'flag' });
    new ReplyGuardrail(input, [context, facts], variables, 0).check('Warm up.');
    const started = performance.now();
    for (let index = 0; index < 200; index += 1)
      new ReplyGuardrail(input, [context, facts], variables, index).check(
        'Your outstanding of ₹4,850 is due on 15 October; can you pay it by then?',
      );
    expect((performance.now() - started) / 200).toBeLessThan(1);
  });
});

async function* deltas(
  parts: readonly string[],
  gate?: Promise<void>,
): AsyncGenerator<InferenceStreamEvent> {
  for (const [index, delta] of parts.entries()) {
    if (index === 1 && gate) await gate;
    yield { kind: 'text-delta', delta };
  }
  yield { kind: 'finish' };
}

describe('guardrail on the streamed reply', () => {
  it('speaks the first checked sentence before the model finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { input, events } = guardrail({ mode: 'block' });
    const guard = new ReplyGuardrail(input, [facts], variables, 1);
    const published: string[] = [];
    const stream = streamAgentReply(
      deltas(['Your dues are ₹4,850. I can', ' waive ₹500 of it. ', 'Shall I send a link?'], gate),
      'en-IN',
      () => undefined,
      (text) => (published.push(text), text),
      undefined,
      (segment) => guard.check(segment),
    );
    // Only the first delta has arrived: its sentence is already spoken.
    await expect(stream.next()).resolves.toEqual({ done: false, value: 'Your dues are ₹4,850.' });
    release();
    await expect(stream.next()).resolves.toEqual({ done: false, value: config.uncertainty });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    expect(published).toEqual(['Your dues are ₹4,850.', config.uncertainty]);
    expect(events).toHaveLength(1);
  });

  it('is built by the pre-reply step from the briefing and call facts, and off when unset', async () => {
    const base = {
      config,
      briefing: config.context,
      facts,
      turnInput: { input: 'can you reduce it?', history: [], variables, today: 'today' },
      signal: new AbortController().signal,
      log: new AgentTurnLog(),
      turn: 4,
      stale: () => false,
      render: (line: string) => line,
    };
    expect((await runPreReplySteps(base)).guard).toBeUndefined();
    const off = guardrail({ mode: 'off' });
    expect((await runPreReplySteps({ ...base, guardrail: off.input })).guard).toBeUndefined();
    const { input, events } = guardrail({ mode: 'block' });
    const prepared = await runPreReplySteps({ ...base, guardrail: input });
    expect(prepared.guard!('The ₹4,850 is due on 15 October.')).toBe(
      'The ₹4,850 is due on 15 October.',
    );
    // The briefing forbids a waiver, so naming one is not declared by it.
    expect(prepared.guard!('I will waive the late fee.')).toBe(config.uncertainty);
    expect(events[0]).toMatchObject({ turn: 4, findings: [{ kind: 'offer', text: 'waive' }] });
  });
});
