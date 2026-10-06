import { describe, expect, it } from 'vitest';
import {
  AgentFlow,
  compileFlow,
  findFlowIntent,
  flowDecisionRequest,
  matchFlowPhrase,
  readFlowAnswer,
  routeFlowIntent,
  type DecisionResponse,
} from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';

const compiled = compileFlow(AgentFlow.parse(collectionsFlow()));

const choice = (
  probabilities: Record<string, number>,
  confidence = 0.9,
): DecisionResponse['answers'][string] => {
  const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0];
  return { type: 'choice', choice: best, confidence, calibrationVersion: 'jev/c', probabilities };
};

const paymentCriteria = (pick: string) => ({
  promise_to_pay: pick === 'promise_to_pay' ? 0.94 : 0.02,
  repeat: pick === 'repeat' ? 0.94 : 0.02,
  stop_calling: pick === 'stop_calling' ? 0.94 : 0.02,
  other: pick === 'other' ? 0.94 : 0.02,
});

describe('one decision request per state', () => {
  it('offers only the current listen set, the globals and other', () => {
    const request = flowDecisionRequest(compiled, 'identity', { caller_reply: 'who is this?' });
    expect(request.questions.intent).toEqual({
      type: 'choice',
      instructions:
        'A collections agent is on a phone call about a missed loan EMI.\n\n' +
        'The agent asked who picked up. How did they respond in `caller_reply`?',
      criteria: {
        confirmed: 'They confirm they are the named person',
        wrong_person: 'It is a wrong number',
        asks_purpose: 'They ask why the agent is calling',
        repeat: 'They want the agent to repeat what it just said',
        stop_calling: 'They ask not to be called again',
        other:
          'None of the above fits: a question, a new topic, or anything the listed options do not cover',
      },
    });
    expect(Object.keys(request.questions)).toEqual(['intent']);
    expect(request.state).toEqual({ caller_reply: 'who is this?' });
  });

  it('asks the listen set slots in the same round trip', () => {
    const request = flowDecisionRequest(compiled, 'payment', { caller_reply: 'tomorrow' });
    expect(Object.keys(request.questions)).toEqual(['intent', 'ptp_when']);
    expect(request.questions.ptp_when).toMatchObject({
      instructions: 'By when do they say they will pay?',
      criteria: { today: 'Today', tomorrow: 'Tomorrow', unspecified: 'No time given' },
    });
  });

  it('never shows the model where an answer leads or what is said there', () => {
    const serialized = JSON.stringify(
      flowDecisionRequest(compiled, 'payment', { caller_reply: 'x' }),
    );
    for (const leak of ['ptp_today', 'ptp_ask', 'promise_to_pay:today', "I've noted", 'disclose'])
      expect(serialized, `request leaked ${leak}`).not.toContain(leak);
  });
});

describe('reading the answer', () => {
  const request = flowDecisionRequest(compiled, 'payment', { caller_reply: 'tomorrow' });
  const response = (intent: string, confidence = 0.9, slotConfidence = 0.9): DecisionResponse => ({
    modelId: 'jev-2026-07-01',
    answers: {
      intent: choice(paymentCriteria(intent), confidence),
      ptp_when: choice({ today: 0.05, tomorrow: 0.9, unspecified: 0.05 }, slotConfidence),
    },
  });

  it('trusts an intent at or above the threshold, with its confident slots', () => {
    expect(readFlowAnswer(compiled, request, response('promise_to_pay'))).toEqual({
      kind: 'intent',
      intent: 'promise_to_pay',
      confidence: 0.9,
      modelId: 'jev-2026-07-01',
      slots: { ptp_when: 'tomorrow' },
    });
  });

  it('drops a slot below the threshold so the route takes its otherwise branch', () => {
    const answer = readFlowAnswer(compiled, request, response('promise_to_pay', 0.9, 0.3));
    expect(answer).toMatchObject({ kind: 'intent', slots: {} });
    const intent = findFlowIntent(compiled, 'payment', 'promise_to_pay')!;
    expect(routeFlowIntent(intent, {})).toEqual({ kind: 'node', node: 'ptp_ask' });
    expect(routeFlowIntent(intent, { ptp_when: 'today' })).toEqual({
      kind: 'node',
      node: 'ptp_today',
    });
    expect(routeFlowIntent(intent, { ptp_when: 'unspecified' })).toEqual({
      kind: 'node',
      node: 'ptp_ask',
    });
  });

  it('reports other and low confidence instead of an intent', () => {
    expect(readFlowAnswer(compiled, request, response('other'))).toMatchObject({ kind: 'other' });
    expect(readFlowAnswer(compiled, request, response('promise_to_pay', 0.4))).toMatchObject({
      kind: 'low-confidence',
      intent: 'promise_to_pay',
      confidence: 0.4,
    });
  });

  it('refuses an answer to a question it was not asked', () => {
    expect(() =>
      readFlowAnswer(compiled, request, {
        modelId: 'jev',
        answers: { intent: choice(paymentCriteria('promise_to_pay')) },
      }),
    ).toThrow(/match requested questions/);
  });

  it('routes a repeat intent to a replay rather than a node', () => {
    expect(routeFlowIntent(findFlowIntent(compiled, 'payment', 'repeat')!, {})).toEqual({
      kind: 'repeat',
    });
  });
});

describe('the instant phrase tier', () => {
  it('matches a whole reply after normalisation, local intents before globals', () => {
    expect(matchFlowPhrase(compiled, 'identity', 'Haan ji!')).toBe('confirmed');
    expect(matchFlowPhrase(compiled, 'identity', '  SPEAKING. ')).toBe('confirmed');
    expect(matchFlowPhrase(compiled, 'wrapup', 'Pardon?')).toBe('repeat');
  });

  it('never matches part of a reply, which goes to the decision model instead', () => {
    expect(matchFlowPhrase(compiled, 'identity', 'yes but not now')).toBeUndefined();
    expect(matchFlowPhrase(compiled, 'identity', '...')).toBeUndefined();
    // A phrase belongs to its listen set: "no" closes the call only where it was authored.
    expect(matchFlowPhrase(compiled, 'identity', 'no')).toBeUndefined();
  });
});
