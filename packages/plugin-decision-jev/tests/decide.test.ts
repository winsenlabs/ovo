import type { UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { resolveBinding } from '../src/binding.ts';
import { jevDecision } from '../src/decide.ts';
import { CHOICE_BODY, NOUL_BODY, SCORE_BODY, jevScript, jevStep } from '../src/testing.ts';
import { LABEL, choiceRequest, noulRequest, scoreRequest, twoQuestionRequest } from './requests.ts';

const binding = (over: Record<string, unknown> = {}) =>
  resolveBinding({ calibrationLabel: LABEL, ...over });

function harness(steps = jevStep({ body: CHOICE_BODY })) {
  const meters: UsageMeter[] = [];
  const net = createFixtureNet([jevScript(steps)]);
  const port = jevDecision(net, 'fixture-key', binding(), (meter) => meters.push(meter), {
    sessionId: 'fixture',
  });
  return { meters, net, port };
}

describe('a happy-path choice decision', () => {
  it('maps the response and meters the reported usage exactly once', async () => {
    const { meters, net, port } = harness();
    const response = await port.decide(choiceRequest, { signal: AbortSignal.timeout(5000) });

    expect(response).toEqual({
      modelId: 'jev-2026-07-01',
      answers: {
        intent: {
          type: 'choice',
          choice: 'pay_now',
          confidence: 0.9,
          probabilities: { pay_now: 0.8, promise_to_pay: 0.1499, dispute: 0.0501 },
          calibrationVersion: `jev-2026-07-01/${LABEL}`,
        },
      },
    });

    // Exactly one meter: `output_tokens` is documented free and is not metered (see README).
    expect(meters).toHaveLength(1);
    expect(meters.map((m) => [m.unit, m.quantity, m.state])).toEqual([
      ['input_tokens', '120', 'reconciled'],
    ]);
    for (const meter of meters) {
      expect(meter.provider).toBe('typesafe');
      expect(meter.operation).toBe('decision');
      expect(meter.requestId).toBe('typesafe:fixture:1');
    }
    net.assertComplete();
  });

  it('posts to the pinned path with a bearer key and the full criteria descriptions', async () => {
    const { net, port } = harness(
      jevStep({
        where: {
          model: 'jev-latest',
          'questions.intent.type': 'choice',
          'questions.intent.criteria.pay_now': 'The caller will pay the full amount immediately.',
          'questions.intent.criteria.dispute': 'The caller disputes the amount.',
        },
        body: CHOICE_BODY,
      }),
    );
    await port.decide(choiceRequest, { signal: AbortSignal.timeout(5000) });
    expect(net.log).toHaveLength(1);
    expect(net.log[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    net.assertComplete();
  });

  it('emits NO usage meter when the optional usage sink is absent', async () => {
    const net = createFixtureNet([jevScript(jevStep({ body: CHOICE_BODY }))]);
    const port = jevDecision(net, 'fixture-key', binding(), undefined, { sessionId: 'fixture' });
    await expect(
      port.decide(choiceRequest, { signal: AbortSignal.timeout(5000) }),
    ).resolves.toBeDefined();
    net.assertComplete();
  });
});

describe('the noul and score primitives', () => {
  it('answers a noul question with the derived yes/no vector', async () => {
    const { meters, net, port } = harness(jevStep({ body: NOUL_BODY }));
    const response = await port.decide(noulRequest, { signal: AbortSignal.timeout(5000) });
    const answer = response.answers.reachable!;
    expect(answer.type).toBe('noul');
    expect(answer.type === 'noul' && answer.noul).toBe(0.72);
    expect(answer.probabilities.yes).toBe(0.72);
    expect(answer.confidence).toBe(0.64);
    expect(meters.map((m) => m.quantity)).toEqual(['40']);
    net.assertComplete();
  });

  it('answers a score question with the rubric-index vector and drops legend', async () => {
    const { net, port } = harness(jevStep({ body: SCORE_BODY }));
    const response = await port.decide(scoreRequest, { signal: AbortSignal.timeout(5000) });
    const answer = response.answers.urgency!;
    expect(answer.type === 'score' && answer.score).toBe(1.7);
    expect(Object.keys(answer.probabilities).sort()).toEqual(['0', '1', '2']);
    expect('legend' in answer).toBe(false);
    net.assertComplete();
  });
});

describe('batching', () => {
  it('answers two questions in ONE request — a second HTTP step is never scripted', async () => {
    const body = {
      model: 'jev-2026-07-01',
      answers: { ...CHOICE_BODY.answers, ...SCORE_BODY.answers },
      usage: { input_tokens: 210, output_tokens: 21 },
    };
    // Exactly one step: a plugin that fanned out per question would consume a step that is absent.
    const { meters, net, port } = harness(jevStep({ body }));
    const response = await port.decide(twoQuestionRequest, { signal: AbortSignal.timeout(5000) });
    expect(Object.keys(response.answers).sort()).toEqual(['intent', 'urgency']);
    expect(net.log).toHaveLength(1);
    expect(meters).toHaveLength(1);
    net.assertComplete();
  });

  it('refuses MORE questions than the binding allows, before any request', async () => {
    const net = createFixtureNet([]);
    const port = jevDecision(net, 'fixture-key', binding({ maxQuestionsPerRequest: 1 }));
    await expect(
      port.decide(twoQuestionRequest, { signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow(/at most 1 questions per request \(got 2\)/);
    expect(net.log).toHaveLength(0);
    net.assertComplete();
  });
});
