import type { UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { resolveBinding } from '../src/binding.ts';
import { jevDecision } from '../src/decide.ts';
import { JevProtocolError } from '../src/wire.ts';
import { CHOICE_BODY, NOUL_BODY, jevScript, jevStep } from '../src/testing.ts';
import { LABEL, choiceRequest, noulRequest } from './requests.ts';

/**
 * Every case here asserts on a VALUE, not on a shape: each body is a well-formed Jev 200 response
 * that the vendor could really return, and each is rejected because one number is wrong. A plugin
 * that renormalized, re-argmaxed or quietly dropped an answer would pass a shape test and fail
 * these.
 */
function port(body: unknown) {
  const meters: UsageMeter[] = [];
  const net = createFixtureNet([jevScript(jevStep({ body }))]);
  const decision = jevDecision(
    net,
    'fixture-key',
    resolveBinding({ calibrationLabel: LABEL }),
    (meter) => meters.push(meter),
    { sessionId: 'fixture' },
  );
  return { meters, net, decision };
}

const choiceWith = (answer: Record<string, unknown>) => ({
  ...CHOICE_BODY,
  answers: { intent: { type: 'choice', ...answer } },
});

const signal = () => ({ signal: AbortSignal.timeout(5000) });

describe('true negatives: a malformed vendor response is refused, never repaired', () => {
  it('probabilities that do not sum to 1 are refused rather than renormalized', async () => {
    const { meters, net, decision } = port(
      choiceWith({
        choice: 'pay_now',
        confidence: 0.9,
        probabilities: { pay_now: 0.8, promise_to_pay: 0.4, dispute: 0.2 },
      }),
    );
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /probabilities are not normalized for intent/,
    );
    // The vendor billed for the tokens, so the failure is still metered exactly once.
    expect(meters.map((m) => [m.unit, m.state])).toEqual([['input_tokens', 'reconciled']]);
    net.assertComplete();
  });

  it('a choice that is not the argmax is refused', async () => {
    const { net, decision } = port(
      choiceWith({
        choice: 'dispute',
        confidence: 0.9,
        probabilities: { pay_now: 0.6, promise_to_pay: 0.2, dispute: 0.2 },
      }),
    );
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /choice is not the highest-probability option for intent/,
    );
    net.assertComplete();
  });

  it('answers that do not match the requested questions are refused', async () => {
    const { net, decision } = port({
      ...CHOICE_BODY,
      answers: { sentiment: CHOICE_BODY.answers.intent },
    });
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /answers must match requested questions/,
    );
    net.assertComplete();
  });

  it('a noul whose value disagrees with P(yes) is refused', async () => {
    const { net, decision } = port({
      ...NOUL_BODY,
      answers: {
        reachable: {
          type: 'noul',
          noul: 0.72,
          confidence: 0.64,
          probabilities: { yes: 0.41, no: 0.59 },
        },
      },
    });
    await expect(decision.decide(noulRequest, signal())).rejects.toThrow(
      /noul differs from yes probability for reachable/,
    );
    net.assertComplete();
  });

  it('a choice OUTSIDE the requested criteria is refused', async () => {
    const { net, decision } = port(
      choiceWith({
        choice: 'not_an_option',
        confidence: 0.9,
        probabilities: { not_an_option: 0.8, promise_to_pay: 0.15, dispute: 0.05 },
      }),
    );
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /probabilities do not cover criteria for intent/,
    );
    net.assertComplete();
  });

  it('an ABSENT probability vector is refused, never synthesized as {chosen: 1}', async () => {
    const { net, decision } = port(choiceWith({ choice: 'pay_now', confidence: 0.9 }));
    const error = await decision.decide(choiceRequest, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevProtocolError);
    expect((error as Error).message).toMatch(/probabilities must be an object/);
    net.assertComplete();
  });

  it('an ABSENT confidence is refused', async () => {
    const { net, decision } = port(
      choiceWith({
        choice: 'pay_now',
        probabilities: { pay_now: 0.8, promise_to_pay: 0.15, dispute: 0.05 },
      }),
    );
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /answers.intent.confidence must be a finite number/,
    );
    net.assertComplete();
  });

  it('an ABSENT usage block is refused rather than metered as zero', async () => {
    const body: Record<string, unknown> = { ...CHOICE_BODY };
    delete body.usage;
    const { meters, net, decision } = port(body);
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /usage must be an object/,
    );
    // Still exactly one meter, but `estimated`: there was nothing to reconcile against.
    expect(meters.map((m) => [m.unit, m.quantity, m.state])).toEqual([
      ['input_tokens', '0', 'estimated'],
    ]);
    net.assertComplete();
  });

  it('a probability that is not a number is refused', async () => {
    const { net, decision } = port(
      choiceWith({
        choice: 'pay_now',
        confidence: 0.9,
        probabilities: { pay_now: '0.8', promise_to_pay: 0.15, dispute: 0.05 },
      }),
    );
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(
      /probabilities.pay_now must be a finite number/,
    );
    net.assertComplete();
  });

  it('a score that disagrees with its own rubric probabilities is refused', async () => {
    const { net, decision } = port({
      model: 'jev-2026-07-01',
      answers: {
        urgency: {
          type: 'score',
          score: 0.2,
          confidence: 0.9,
          probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const scoreRequest = {
      state: 's',
      questions: {
        urgency: {
          type: 'score' as const,
          instructions: 'How urgent is this?',
          criteria: ['Can wait', 'This week', 'Today'],
        },
      },
    };
    await expect(decision.decide(scoreRequest, signal())).rejects.toThrow(
      /score differs from rubric probabilities for urgency/,
    );
    net.assertComplete();
  });

  it('malformed JSON in a 200 is refused', async () => {
    const net = createFixtureNet([jevScript(jevStep({ body: '{not json' }))]);
    const decision = jevDecision(net, 'k', resolveBinding({ calibrationLabel: LABEL }));
    await expect(decision.decide(choiceRequest, signal())).rejects.toThrow(/body is unusable/);
    net.assertComplete();
  });
});
