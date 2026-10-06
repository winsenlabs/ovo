import { describe, expect, it } from 'vitest';
import { AgentConfig, type DecisionAnswer, type DecisionPort } from '@winsendotai/ovo-contracts';
import { call, llm } from './agent-call-control-fixture.ts';
import { jev, jevOnly, policy } from './jev-only-fixture.ts';
import { RULES_MODEL_ID, ruledDecisionGate } from '../src/rules-gate.ts';

const rules = {
  global: [
    { intent: 'intent=pay', lexicons: ['yes'], phrases: ['I will pay today'] },
    { intent: 'intent=bye', lexicons: ['bye', 'thanks'] },
  ],
};

describe('the instant rules tier in an agent (AGT-6)', () => {
  it('answers a rule-matched reply with no decision-model call', async () => {
    const decision = jev();
    const behavior = jevOnly({ decision: policy(), rules }, decision.port);
    expect(await behavior.respond('Haan ji!', call)).toBe('Thank you, Ravi.');
    expect(await behavior.respond('i will pay TODAY.', call)).toBe('Thank you, Ravi.');
    expect(decision.seen).toHaveLength(0);
    expect(behavior.decisions.at(-1)?.result).toMatchObject({
      kind: 'decided',
      modelId: RULES_MODEL_ID,
      resolutions: [{ used: true, questionId: 'intent', answer: { choice: 'pay', confidence: 1 } }],
    });
  });

  it("keeps the outcome's end: a rule-matched goodbye ends the call", async () => {
    const behavior = jevOnly({ decision: policy(), rules }, jev().port);
    behavior.beginTurn(1);
    expect(await behavior.respond('okay bye', call)).toBe('Goodbye.');
    behavior.onPlayback({
      id: 'x',
      text: 'Goodbye.',
      epoch: 1,
      state: 'completed',
      evidence: 'confirmed',
    });
    expect(behavior.completionReason()).toBe('decision:intent=bye');
  });

  it('asks the decision model about anything the rules do not match', async () => {
    const decision = jev(['other', 0.9]);
    const behavior = jevOnly({ decision: policy(), rules }, decision.port);
    expect(await behavior.respond('yes but my salary comes on the 10th', call)).toBe(
      'Let me note that.',
    );
    expect(decision.seen).toHaveLength(1);
  });

  it('does nothing for a disabled rule set', async () => {
    const decision = jev(['other', 0.9]);
    const behavior = jevOnly(
      { decision: policy(), rules: { ...rules, enabled: false } },
      decision.port,
    );
    expect(await behavior.respond('yes', call)).toBe('Let me note that.');
    expect(decision.seen).toHaveLength(1);
  });
});

describe('rules alongside a decision model asked several questions', () => {
  const twoQuestions = {
    ...policy(),
    questions: [
      ...policy().questions,
      {
        type: 'noul',
        id: 'callback',
        instructions: 'Does the caller want a call back?',
        threshold: 0.8,
        fallback: 'clarify',
        yes: { description: 'Wants a callback', outcome: { say: 'I will call you back.' } },
        no: { description: 'Does not', outcome: {} },
      },
    ],
  };
  const answers = (seen: string[]): DecisionPort => ({
    decide: async (request) => {
      seen.push(...Object.keys(request.questions));
      return {
        modelId: 'jev-1',
        answers: {
          intent: {
            type: 'choice',
            choice: 'other',
            confidence: 0.9,
            calibrationVersion: 'jev-1/a',
            probabilities: { pay: 0.05, bye: 0.05, other: 0.9 },
          } as DecisionAnswer,
          callback: {
            type: 'noul',
            noul: 0.9,
            confidence: 0.9,
            calibrationVersion: 'jev-1/a',
            probabilities: { yes: 0.9, no: 0.1 },
          } as DecisionAnswer,
        },
      };
    },
  });

  it("asks the model and lets the rule's answer replace the model's for its question", async () => {
    const seen: string[] = [];
    const config = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      decision: twoQuestions,
      rules: { global: [{ intent: 'intent=pay', lexicons: ['yes'] }] },
    });
    const gate = ruledDecisionGate(config, answers(seen))!;
    const verdict = await gate.evaluate(
      { input: 'yes', history: [], variables: {}, context: '' },
      new AbortController().signal,
    );
    expect(seen).toEqual(['intent', 'callback']);
    expect(verdict).toMatchObject({
      kind: 'decided',
      modelId: 'jev-1',
      resolutions: [
        { questionId: 'intent', answer: { choice: 'pay', confidence: 1 } },
        { questionId: 'callback', answer: { noul: 0.9 } },
      ],
      action: { say: 'Thank you, {{name}}.' },
    });
    expect(gate.last).toBe(verdict);
  });

  it('skips the model when rules answer every question', async () => {
    const seen: string[] = [];
    const config = AgentConfig.parse({
      name: 'A',
      mode: 'agent',
      decision: twoQuestions,
      rules: {
        global: [
          { intent: 'callback=no', phrases: ['no need'] },
          { intent: 'intent=bye', phrases: ['no need'] },
        ],
      },
    });
    const verdict = await ruledDecisionGate(config, answers(seen))!.evaluate(
      { input: 'No need.', history: [], variables: {}, context: '' },
      new AbortController().signal,
    );
    expect(seen).toEqual([]);
    expect(verdict).toMatchObject({
      modelId: RULES_MODEL_ID,
      action: { say: 'Goodbye.', end: 'intent=bye' },
    });
  });

  it('still uses the LLM fallback when one is bound and the rule outcome defers to it', async () => {
    const model = llm();
    const behavior = jevOnly(
      {
        decision: {
          ...policy(),
          questions: [
            {
              ...policy().questions[0],
              options: [
                { key: 'pay', description: 'Will pay', outcome: {} },
                { key: 'bye', description: 'Wants to go', outcome: { say: 'Goodbye.' } },
              ],
            },
          ],
        },
        rules: { global: [{ intent: 'intent=pay', lexicons: ['yes'] }] },
      },
      jev().port,
      model,
    );
    expect(await behavior.respond('yes', call)).toBe('A composed LLM answer.');
    expect(model.requests).toHaveLength(1);
  });
});
