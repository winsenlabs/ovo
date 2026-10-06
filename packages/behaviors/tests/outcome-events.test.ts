import { describe, expect, it, vi } from 'vitest';
import { readSessionEvent, type EventSink } from '@winsendotai/ovo-contracts';
import { recordSessionEvent, routeEventFromDecision } from '../src/outcome-events.ts';
import type { DecisionGateResult } from '../src/decision-gate.ts';

const answer = (choice: string, confidence: number) => ({
  type: 'choice' as const,
  choice,
  confidence,
  calibrationVersion: 'cal-1',
  probabilities: { promise_to_pay: 0.8, dispute: 0.15, other: 0.04, busy: 0.01 },
});

const decided = (
  action: Partial<{ say: string; deferToLlm: boolean; clarify: boolean; end: string }>,
  used = true,
): DecisionGateResult => ({
  kind: 'decided',
  modelId: 'jev-1',
  resolutions: [
    used
      ? {
          used: true,
          questionId: 'intent',
          outcome: { say: 'Thanks.' },
          answer: answer('promise_to_pay', 0.8),
        }
      : {
          used: false,
          questionId: 'intent',
          reason: 'below-threshold',
          fallback: 'llm',
          confidence: 0.4,
          threshold: 0.6,
          answer: answer('promise_to_pay', 0.4),
        },
  ],
  action: { deferToLlm: false, clarify: false, ...action },
});

describe('turn.route from a decision (AGT-8)', () => {
  it('records the tier that answered, the intent, confidence and the top three', () => {
    const route = routeEventFromDecision(2, decided({ say: 'Thanks.' }));
    expect(route).toEqual({
      turn: 2,
      tier: 'jev',
      modelId: 'jev-1',
      intent: 'intent=promise_to_pay',
      confidence: 0.8,
      top3: [
        { intent: 'promise_to_pay', confidence: 0.8 },
        { intent: 'dispute', confidence: 0.15 },
        { intent: 'other', confidence: 0.04 },
      ],
    });
    expect(readSessionEvent('turn.route', route).type).toBe('turn.route');
    expect(routeEventFromDecision(3, decided({ deferToLlm: true }, false))).toMatchObject({
      tier: 'llm',
      fallbackReason: 'low_confidence',
      confidence: 0.4,
    });
    expect(routeEventFromDecision(4, decided({ clarify: true }, false))).toMatchObject({
      tier: 'jev',
      fallbackReason: 'clarify',
    });
    expect(
      routeEventFromDecision(5, { kind: 'unavailable', reason: 'timeout', message: 'slow' }),
    ).toEqual({ turn: 5, tier: 'llm', fallbackReason: 'timeout' });
    expect(routeEventFromDecision(6, { kind: 'off' })).toBeNull();
  });

  it('never waits on the sink and skips a missing sink or event', () => {
    const append = vi.fn<EventSink['append']>(() => new Promise(() => undefined));
    recordSessionEvent({ append }, 'turn.route', { turn: 1, tier: 'llm' });
    recordSessionEvent({ append }, 'turn.route', null);
    recordSessionEvent(undefined, 'turn.route', { turn: 1, tier: 'llm' });
    expect(append).toHaveBeenCalledTimes(1);
  });
});
