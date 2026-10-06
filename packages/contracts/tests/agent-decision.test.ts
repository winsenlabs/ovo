import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  AgentDecisionPolicy,
  compileDecisionRequest,
  decisionQuestionPayload,
  resolveDecision,
  validateDecisionExchange,
  type AgentDecisionQuestion,
  type DecisionAnswer,
} from '../src/index.ts';

const choice = {
  type: 'choice' as const,
  id: 'intent',
  instructions: 'What is the caller asking for?',
  threshold: 0.8,
  fallback: 'llm' as const,
  expected: 'pay_now',
  options: [
    {
      key: 'pay_now',
      description: 'Wants to pay the outstanding now',
      outcome: { say: 'Sending a link.' },
    },
    {
      key: 'dispute',
      description: 'Disputes the amount',
      outcome: { say: 'Noting your dispute.' },
    },
    { key: 'other', description: 'Anything else', outcome: {} },
  ],
};

const noul = {
  type: 'noul' as const,
  id: 'promised',
  instructions: 'Did the caller promise to pay?',
  threshold: 0.7,
  fallback: 'clarify' as const,
  yes: { description: 'A clear promise', outcome: { say: 'Thank you.' } },
  no: { description: 'No promise', outcome: { say: 'Understood.' } },
};

const score = {
  type: 'score' as const,
  id: 'willingness',
  instructions: 'How willing is the caller to pay?',
  threshold: 0.6,
  fallback: 'llm' as const,
  rubric: ['Refuses', 'Hesitant', 'Willing'],
  bands: [
    { atLeast: 0, outcome: { say: 'I will note your position.' } },
    { atLeast: 1.5, outcome: { say: 'Let me take the payment.' } },
  ],
  expectedAtLeast: 1.5,
};

const answer = (over: Partial<DecisionAnswer> & Pick<DecisionAnswer, 'type'>): DecisionAnswer =>
  ({ confidence: 0.95, calibrationVersion: 'jev-1/cohort-a', ...over }) as DecisionAnswer;

describe('authored decision policy', () => {
  it('sends the model the options and nothing the operator decided about them', () => {
    const payload = decisionQuestionPayload(choice as AgentDecisionQuestion);
    expect(payload).toEqual({
      type: 'choice',
      instructions: 'What is the caller asking for?',
      criteria: {
        pay_now: 'Wants to pay the outstanding now',
        dispute: 'Disputes the amount',
        other: 'Anything else',
      },
    });
    // The threshold, the expectation and every spoken outcome stay on this side of the wire: the
    // model must not be able to read what its answer will trigger or what answer was hoped for.
    const serialized = JSON.stringify(payload);
    for (const leak of [
      'threshold',
      '0.8',
      'expected',
      'fallback',
      'llm',
      'Sending a link',
      'Noting your dispute',
    ])
      expect(serialized, `payload leaked ${leak}`).not.toContain(leak);
  });

  it('asks every question in one request, keyed by the authored ids', () => {
    const policy = AgentDecisionPolicy.parse({
      enabled: true,
      questions: [choice, noul, score],
      state: { sources: ['last-turn'] },
    });
    const request = compileDecisionRequest(policy, { lastCallerTurn: 'I can pay tomorrow' });
    expect(Object.keys(request.questions)).toEqual(['intent', 'promised', 'willingness']);
    expect(request.state).toEqual({ lastCallerTurn: 'I can pay tomorrow' });
  });

  it('produces a request the shared wire validator accepts', () => {
    const policy = AgentDecisionPolicy.parse({
      enabled: true,
      questions: [choice, noul, score],
      state: { sources: ['last-turn'] },
    });
    const request = compileDecisionRequest(policy, { lastCallerTurn: 'hello' });
    expect(() =>
      validateDecisionExchange(request, {
        modelId: 'jev-1',
        answers: {
          intent: answer({
            type: 'choice',
            choice: 'pay_now',
            probabilities: { pay_now: 0.9, dispute: 0.05, other: 0.05 },
          }),
          promised: answer({ type: 'noul', noul: 0.8, probabilities: { yes: 0.8, no: 0.2 } }),
          willingness: answer({
            type: 'score',
            score: 1.7,
            probabilities: { '0': 0.1, '1': 0.1, '2': 0.8 },
          }),
        },
      }),
    ).not.toThrow();
  });
});

describe('authoring rules', () => {
  const policy = (questions: unknown[]) =>
    AgentDecisionPolicy.parse({ enabled: true, questions, state: { sources: ['last-turn'] } });

  it('rejects duplicate question ids', () => {
    expect(() => policy([choice, { ...choice }])).toThrow(/unique/i);
  });
  it('rejects duplicate option keys', () => {
    expect(() =>
      policy([
        { ...choice, options: [choice.options[0]!, choice.options[0]!], expected: undefined },
      ]),
    ).toThrow(/unique/i);
  });
  it('rejects an expected answer that is not on offer', () => {
    expect(() => policy([{ ...choice, expected: 'absent' }])).toThrow(/Expected answer/);
  });
  it('rejects a single-option choice, which is not a decision', () => {
    expect(() =>
      policy([{ ...choice, options: [choice.options[0]], expected: 'pay_now' }]),
    ).toThrow();
  });
  it('rejects score bands that leave a reachable score unresolved', () => {
    expect(() => policy([{ ...score, bands: [{ atLeast: 1, outcome: { say: 'x' } }] }])).toThrow(
      /starting at 0/,
    );
  });
  it('rejects a score band above the highest rubric index, which can never fire', () => {
    expect(() =>
      policy([{ ...score, bands: [...score.bands, { atLeast: 9, outcome: { say: 'x' } }] }]),
    ).toThrow(/never be reached/);
  });
  it('rejects duplicate band thresholds, which would make the outcome order-dependent', () => {
    expect(() =>
      policy([{ ...score, bands: [score.bands[0]!, { atLeast: 0, outcome: { say: 'y' } }] }]),
    ).toThrow(/distinct/);
  });
  it('rejects an expected score nobody can reach', () => {
    expect(() => policy([{ ...score, expectedAtLeast: 7 }])).toThrow(/highest rubric index/);
  });
  it('rejects duplicate state sources', () => {
    expect(() =>
      AgentDecisionPolicy.parse({
        enabled: true,
        questions: [choice],
        state: { sources: ['last-turn', 'last-turn'] },
      }),
    ).toThrow(/unique/i);
  });
  it('requires at least one state source: a decision grounded in nothing is a guess', () => {
    expect(() =>
      AgentDecisionPolicy.parse({ enabled: true, questions: [choice], state: { sources: [] } }),
    ).toThrow();
  });
  it('has no handoff fallback, because no handoff port is implemented', () => {
    expect(() => policy([{ ...choice, fallback: 'handoff' }])).toThrow();
  });
  it('has no disposition or script-jump outcome, because neither has a sink or a router', () => {
    expect(() =>
      policy([
        {
          ...choice,
          options: [
            { ...choice.options[0]!, outcome: { say: 'a', disposition: 'paid' } },
            choice.options[1],
          ],
        },
      ]),
    ).toThrow();
    expect(() =>
      policy([
        {
          ...choice,
          options: [{ ...choice.options[0]!, outcome: { next: 'node-2' } }, choice.options[1]],
        },
      ]),
    ).toThrow();
  });
  it('bounds the timeout, because a decision sits in front of the reply', () => {
    const parsed = AgentDecisionPolicy.parse({
      enabled: true,
      questions: [choice],
      state: { sources: ['last-turn'] },
    });
    expect(parsed.timeoutMs).toBe(800);
    expect(() =>
      AgentDecisionPolicy.parse({
        enabled: true,
        questions: [choice],
        state: { sources: ['last-turn'] },
        timeoutMs: 60_000,
      }),
    ).toThrow();
  });
  it('rides on AgentConfig so a release carries it', () => {
    const config = AgentConfig.parse({
      name: 'Collections',
      mode: 'agent',
      decision: { enabled: true, questions: [choice], state: { sources: ['last-turn'] } },
    });
    expect(config.decision?.questions[0]!.id).toBe('intent');
  });
});

describe('applying an answer', () => {
  it('uses the outcome of the chosen option', () => {
    const resolution = resolveDecision(
      choice as AgentDecisionQuestion,
      answer({
        type: 'choice',
        choice: 'dispute',
        probabilities: { pay_now: 0.1, dispute: 0.8, other: 0.1 },
      }),
    );
    expect(resolution).toMatchObject({
      used: true,
      outcome: { say: 'Noting your dispute.' },
      asExpected: false,
    });
  });

  it('reports a match against the operator expectation', () => {
    const resolution = resolveDecision(
      choice as AgentDecisionQuestion,
      answer({
        type: 'choice',
        choice: 'pay_now',
        probabilities: { pay_now: 0.9, dispute: 0.05, other: 0.05 },
      }),
    );
    expect(resolution).toMatchObject({ used: true, asExpected: true });
  });

  it('reports no expectation when the operator authored none', () => {
    const resolution = resolveDecision(
      { ...choice, expected: undefined } as AgentDecisionQuestion,
      answer({
        type: 'choice',
        choice: 'pay_now',
        probabilities: { pay_now: 0.9, dispute: 0.05, other: 0.05 },
      }),
    );
    expect(resolution.used).toBe(true);
    expect('asExpected' in resolution).toBe(false);
  });

  it('discards an answer below the authored threshold and names the fallback', () => {
    const resolution = resolveDecision(
      choice as AgentDecisionQuestion,
      answer({
        type: 'choice',
        choice: 'pay_now',
        confidence: 0.79,
        probabilities: { pay_now: 0.5, dispute: 0.3, other: 0.2 },
      }),
    );
    expect(resolution).toEqual({
      used: false,
      questionId: 'intent',
      reason: 'below-threshold',
      fallback: 'llm',
      confidence: 0.79,
      threshold: 0.8,
      answer: expect.objectContaining({ choice: 'pay_now' }),
    });
  });

  it('treats the threshold as inclusive, so an exactly-at-threshold answer is used', () => {
    const resolution = resolveDecision(
      choice as AgentDecisionQuestion,
      answer({
        type: 'choice',
        choice: 'pay_now',
        confidence: 0.8,
        probabilities: { pay_now: 0.9, dispute: 0.05, other: 0.05 },
      }),
    );
    expect(resolution.used).toBe(true);
  });

  it('splits a noul at 0.5 and reports the expectation against the side taken', () => {
    const yes = resolveDecision(
      { ...noul, expected: 'yes' } as AgentDecisionQuestion,
      answer({ type: 'noul', noul: 0.5, probabilities: { yes: 0.5, no: 0.5 } }),
    );
    expect(yes).toMatchObject({ used: true, outcome: { say: 'Thank you.' }, asExpected: true });
    const no = resolveDecision(
      { ...noul, expected: 'yes' } as AgentDecisionQuestion,
      answer({ type: 'noul', noul: 0.49, probabilities: { yes: 0.49, no: 0.51 } }),
    );
    expect(no).toMatchObject({ used: true, outcome: { say: 'Understood.' }, asExpected: false });
  });

  it('picks the highest score band at or below the score', () => {
    const low = resolveDecision(
      score as AgentDecisionQuestion,
      answer({ type: 'score', score: 1.49, probabilities: { '0': 0.3, '1': 0.6, '2': 0.1 } }),
    );
    expect(low).toMatchObject({
      used: true,
      outcome: { say: 'I will note your position.' },
      asExpected: false,
    });
    const high = resolveDecision(
      score as AgentDecisionQuestion,
      answer({ type: 'score', score: 1.5, probabilities: { '0': 0.1, '1': 0.3, '2': 0.6 } }),
    );
    expect(high).toMatchObject({
      used: true,
      outcome: { say: 'Let me take the payment.' },
      asExpected: true,
    });
  });

  it('resolves bands independently of the order they were authored in', () => {
    const reversed = { ...score, bands: [...score.bands].reverse() } as AgentDecisionQuestion;
    expect(
      resolveDecision(
        reversed,
        answer({ type: 'score', score: 2, probabilities: { '0': 0, '1': 0, '2': 1 } }),
      ),
    ).toMatchObject({ outcome: { say: 'Let me take the payment.' } });
  });

  it('refuses an answer of the wrong type rather than guessing', () => {
    expect(() =>
      resolveDecision(
        choice as AgentDecisionQuestion,
        answer({ type: 'noul', noul: 0.9, probabilities: { yes: 0.9, no: 0.1 } }),
      ),
    ).toThrow(/is a noul, but the question is a choice/);
  });

  it('refuses a choice the question does not offer', () => {
    expect(() =>
      resolveDecision(
        choice as AgentDecisionQuestion,
        answer({ type: 'choice', choice: 'invented', probabilities: { invented: 1 } }),
      ),
    ).toThrow(/which intent does not offer/);
  });
});
