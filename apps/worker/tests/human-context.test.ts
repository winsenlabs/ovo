import { describe, expect, it } from 'vitest';
import { CallMemory } from '../src/call-memory.ts';
import { buildTicketContext, maskNumber } from '../src/human-context.ts';
import type { QueueContextPolicy } from '../src/human-contract.ts';

const policy = (over: Partial<QueueContextPolicy> = {}): QueueContextPolicy => ({
  callerId: false,
  calledNumber: false,
  language: true,
  intent: true,
  summary: true,
  transcriptTurns: 0,
  transcriptLink: true,
  variables: [],
  summarize: 'agent_only',
  ...over,
});

function memory() {
  const m = new CallMemory();
  m.observe('route.decision', {
    path: ['intent', 'billing'],
    language: 'hi',
    context: { intent: 'billing', segment: 'gold' },
  });
  for (let i = 1; i <= 8; i += 1)
    m.transcript({
      type: 'user.transcript',
      turnId: `t${i}`,
      segmentId: `s${i}`,
      text: `line ${i}`,
      stability: 'final',
    });
  return m;
}

const build = (over: Partial<Parameters<typeof buildTicketContext>[0]> = {}) =>
  buildTicketContext({
    policy: policy(),
    callId: 'call-1',
    numbers: { from: '+919800001234', to: '+918000000002' },
    memory: memory(),
    meta: { summary: 'Wants a refund of 500.', reason: 'billing question' },
    askedFor: 'billing',
    from: { role: 'agent', agentId: 'agent-a', releaseId: 'release-a' },
    values: { account_id: 'A-1', pin: '4321', nested: { a: 1 } },
    returnTargets: [{ key: 'billing', label: 'Billing' }],
    ...over,
  });

describe('the ticket context (human queue design 7.3)', () => {
  it('gives an external queue the minimum by default: no numbers, no transcript, no variables', () => {
    const context = build();
    expect(context).toMatchObject({
      callId: 'call-1',
      brief: 'Language: Hindi. Intent: billing. Asked for: billing.',
      summary: 'Wants a refund of 500.',
      reason: 'billing question',
      language: 'hi',
      intent: 'billing',
      routePath: ['intent', 'billing'],
      caller: {},
      transcript: [],
      variables: {},
      fromAgent: { agentId: 'agent-a', releaseId: 'release-a' },
    });
    expect(JSON.stringify(context)).not.toContain('9800001234');
  });

  it('turns each field on and off with the policy', () => {
    const on = build({
      policy: policy({
        callerId: true,
        calledNumber: true,
        transcriptTurns: 3,
        variables: ['account_id'],
      }),
    });
    expect(on.caller).toEqual({ number: '+919800001234', calledNumber: '+918000000002' });
    expect(on.transcript.map((line) => line.text)).toEqual(['line 6', 'line 7', 'line 8']);
    expect(on.variables).toEqual({ account_id: 'A-1' });
    const off = build({ policy: policy({ language: false, intent: false, summary: false }) });
    expect(off).not.toHaveProperty('summary');
    expect(off).not.toHaveProperty('language');
    expect(off).not.toHaveProperty('intent');
    expect(off.brief).toBe('Asked for: billing.');
  });

  it('takes declared variables as given (scalars only) and an allow-list as the cap', () => {
    const declared = build({ policy: policy({ variables: 'declared' }) });
    expect(declared.variables).toEqual({ account_id: 'A-1', pin: '4321' });
    const many = build({
      policy: policy({ variables: 'declared' }),
      values: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`v${i}`, `x${i}`])),
    });
    expect(Object.keys(many.variables)).toHaveLength(20);
  });

  it('caps the free text it keeps: summary, reason, lines and the whole transcript', () => {
    const long = 'x'.repeat(2_000);
    const m = new CallMemory();
    for (let i = 0; i < 20; i += 1)
      m.transcript({
        type: 'user.transcript',
        turnId: `t${i}`,
        segmentId: `s${i}`,
        text: long,
        stability: 'final',
      });
    const context = build({
      policy: policy({ transcriptTurns: 20 }),
      memory: m,
      meta: { summary: long, reason: long },
    });
    expect(context.summary).toHaveLength(1_000);
    expect(context.reason).toHaveLength(200);
    expect(context.transcript.every((line) => line.text.length <= 500)).toBe(true);
    expect(context.transcript.reduce((n, line) => n + line.text.length, 0)).toBeLessThanOrEqual(
      6_000,
    );
  });

  it('names no agent when the request came from the router', () => {
    expect(
      build({ from: { role: 'router', agentId: 'front', releaseId: 'r' } }),
    ).not.toHaveProperty('fromAgent');
  });

  it('masks a number to its country prefix and last four digits', () => {
    expect(maskNumber('+919800001234')).toBe('+91******1234');
    expect(maskNumber('+1555')).toBe('*****');
    expect(maskNumber(undefined)).toBeUndefined();
  });
});
