import { describe, expect, it } from 'vitest';
import {
  EXTERNAL_CONTEXT_DEFAULT,
  MANAGED_CONTEXT_DEFAULT,
  HumanQueueDefinition,
} from '@winsendotai/ovo-contracts';
import { externalContext, policyOf } from '../src/human-queue-context-policy.ts';
import {} from './human-queue-fixtures.ts';
import { context } from './human-queue-data.ts';
import { RateLimiter } from '../src/human-queue-ports.ts';

const FULL = context();

describe('externalContext', () => {
  it('sends the strict default: language, intent, summary, no caller, no transcript, no variables', () => {
    const out = externalContext(FULL, EXTERNAL_CONTEXT_DEFAULT);
    expect(out).toMatchObject({
      callId: 'call-1',
      summary: 'Caller asks about a charge.',
      reason: 'wants a person',
      language: 'en',
      intent: 'billing',
      routePath: ['intent', 'billing'],
      caller: {},
      transcript: [],
      variables: {},
      returnTargets: [],
    });
    expect(JSON.stringify(out)).not.toContain('9800000000');
  });

  it('adds only what each switch turns on', () => {
    const out = externalContext(FULL, {
      ...EXTERNAL_CONTEXT_DEFAULT,
      callerId: true,
      transcriptTurns: 2,
      variables: ['account'],
    });
    expect(out.caller).toEqual({ number: '+919800000000' });
    expect(out.transcript.map((t) => t.text)).toEqual(['two', 'three']);
    expect(out.variables).toEqual({ account: 'A1' });
    expect(
      externalContext(FULL, { ...EXTERNAL_CONTEXT_DEFAULT, calledNumber: true }).caller,
    ).toEqual({ calledNumber: '+918000000001' });
  });

  it('drops text and routing the policy switches off', () => {
    const out = externalContext(FULL, {
      ...EXTERNAL_CONTEXT_DEFAULT,
      summary: false,
      language: false,
      intent: false,
    });
    expect(out.summary).toBeUndefined();
    expect(out.reason).toBeUndefined();
    expect(out.language).toBeUndefined();
    expect(out.intent).toBeUndefined();
    expect(out.routePath).toEqual([]);
  });

  it('treats the desk-only "declared" variables as an empty allow-list, and never forwards send-back targets or the transferring agent', () => {
    const out = externalContext(
      { ...FULL, fromAgent: { agentId: 'a', releaseId: '11111111-1111-4111-8111-111111111111' } },
      MANAGED_CONTEXT_DEFAULT,
    );
    expect(out.variables).toEqual({});
    expect(out.returnTargets).toEqual([]);
    expect(out.fromAgent).toBeUndefined();
  });
});

describe('policyOf', () => {
  it('is the queue’s own policy, or the strictest default when the queue is unknown', () => {
    const definition = HumanQueueDefinition.parse({ kind: 'managed', name: 'M' });
    expect(policyOf(definition)).toEqual(MANAGED_CONTEXT_DEFAULT);
    expect(policyOf(undefined)).toEqual(EXTERNAL_CONTEXT_DEFAULT);
  });
});

describe('RateLimiter', () => {
  it('allows the limit within the window and slides', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1_000, () => now);
    expect([1, 2, 3, 4].map(() => limiter.take('k'))).toEqual([true, true, true, false]);
    expect(limiter.retryAfterSeconds('k')).toBe(1);
    now = 600;
    expect(limiter.take('k')).toBe(false);
    now = 1_001;
    expect(limiter.take('k')).toBe(true);
    expect(limiter.take('other')).toBe(true);
  });

  it('keeps its memory bounded under many keys', () => {
    const limiter = new RateLimiter(1, 60_000, () => 0, 3);
    for (const key of ['a', 'b', 'c', 'd']) limiter.take(key);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('d')).toBe(false);
  });
});
