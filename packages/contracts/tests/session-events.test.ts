import { describe, expect, it } from 'vitest';
import {
  AgentGuardrailPolicy,
  GUARDRAIL_CHECKS,
  readSessionEvent,
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_TYPES,
} from '../src/index.ts';

describe('session events (AGT-8)', () => {
  it('validates each event type and keeps fields a newer emitter adds', () => {
    const route = readSessionEvent('turn.route', {
      turn: 2,
      tier: 'jev',
      node: 'disclose',
      listen: 'disclose',
      intent: 'promise_to_pay',
      confidence: 0.91,
      top3: [{ intent: 'promise_to_pay', confidence: 0.91 }],
      slots: { when: 'tomorrow' },
      jevMs: 212,
      speculative: true,
    });
    expect(route).toEqual({
      type: 'turn.route',
      payload: expect.objectContaining({ tier: 'jev', speculative: true }),
    });
    expect(readSessionEvent('disposition', { disposition: 'ptp_tomorrow' }).payload).toEqual({
      disposition: 'ptp_tomorrow',
      source: 'system',
    });
    for (const [type, payload] of [
      ['flow.state', { to: 'ptp_ask', from: 'disclose', turn: 3 }],
      ['variables.captured', { variables: { promised_date: '2026-10-07' } }],
      [
        'guardrail',
        { turn: 1, action: 'blocked', findings: [{ kind: 'amount', text: '₹500' }], checkUs: 40 },
      ],
      ['call.outcome', { outcome: 'completed', reason: 'behavior_completed' }],
    ] as const)
      expect(readSessionEvent(type, payload).type).toBe(type);
    expect(SESSION_EVENT_TYPES).toHaveLength(6);
  });

  it('refuses unknown types, malformed payloads and oversized ones', () => {
    expect(() => readSessionEvent('turn.routed', { turn: 1, tier: 'jev' })).toThrow();
    expect(() => readSessionEvent('turn.route', { turn: 1, tier: 'magic' })).toThrow();
    expect(() => readSessionEvent('turn.route', { turn: -1, tier: 'jev' })).toThrow();
    expect(() => readSessionEvent('turn.route', { turn: 1, tier: 'jev', confidence: 2 })).toThrow();
    expect(() =>
      readSessionEvent('guardrail', { turn: 1, action: 'flagged', findings: [], checkUs: 1 }),
    ).toThrow();
    expect(() =>
      readSessionEvent('variables.captured', {
        variables: { note: 'x'.repeat(SESSION_EVENT_MAX_BYTES) },
      }),
    ).toThrow(/limit/);
  });
});

describe('AgentGuardrailPolicy', () => {
  it('defaults to flagging every check and refuses unknown fields', () => {
    expect(AgentGuardrailPolicy.parse({})).toEqual({
      mode: 'flag',
      checks: [...GUARDRAIL_CHECKS],
      allow: [],
    });
    expect(
      AgentGuardrailPolicy.parse({ mode: 'block', safeLine: ' Let me check. ' }),
    ).toMatchObject({ mode: 'block', safeLine: 'Let me check.' });
    expect(() => AgentGuardrailPolicy.parse({ mode: 'block', extra: true })).toThrow();
    expect(() => AgentGuardrailPolicy.parse({ checks: ['phone'] })).toThrow();
  });
});
