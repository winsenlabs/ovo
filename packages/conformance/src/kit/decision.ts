/**
 * `decision@1`: the conformance kit for the `Cap.decision` slot. `validateDecisionExchange`
 * (`contracts/src/decision.ts`) already enforces structural correctness; this kit tests the
 * behaviour a schema cannot — that criteria reach the provider verbatim, that a batch of questions
 * costs one round trip, that confidence moves with the input, that the calibration cohort is
 * identifiable and model-specific, that an abort is honoured and that a malformed provider reply is
 * REFUSED rather than repaired.
 *
 * It cannot prove the provider is calibrated: a fixture returns what it is scripted to return.
 * Calibration is measured offline on real transcripts and gated separately. A green kit is not a
 * trustworthy confidence threshold.
 *
 * This module holds the checks on what one exchange must carry. `decision-confidence.ts` holds the
 * checks on whether the number can be trusted, `decision-limits.ts` the boundaries and the
 * plumbing, and `decision-negatives.ts` the refusals.
 */
import type { DecisionQuestion, DecisionRequest } from '@winsendotai/ovo-contracts';
import { DECISION_CONFIDENCE_CHECKS } from './decision-confidence.ts';
import { answerOf, driveDecision, exchangeFailures, netFailures } from './decision-harness.ts';
import { DECISION_LIMIT_CHECKS } from './decision-limits.ts';
import { DECISION_NEGATIVE_CHECKS } from './decision-negatives.ts';
import {
  choiceAnswer,
  choiceOf,
  choicePlan,
  decisionReply,
  modelsOf,
  primitivesPlan,
  runToken,
  stateOf,
  type DecisionKitContext,
} from './decision-support.ts';
import { Failures, type KitCheck } from './runner.ts';

export type {
  DecisionFactory,
  DecisionKitContext,
  DecisionKitOptions,
  DecisionPlannedExchange,
  DecisionScriptPlan,
  DecisionTemplate,
} from './decision-support.ts';
export type { DecisionRun } from './decision-harness.ts';
export {
  KIT_MODELS,
  decisionCriteriaWhere,
  decisionHttpStep,
  decisionReply,
} from './decision-support.ts';
export { driveDecision } from './decision-harness.ts';

const EXCHANGE_CHECKS: readonly KitCheck<DecisionKitContext>[] = [
  {
    name: 'a single choice question is answered and satisfies validateDecisionExchange',
    async run(context) {
      const f = new Failures();
      const plan = choicePlan(context, [
        { said: 'I want to pay the whole amount today', confidence: 0.91, winner: 1 },
      ]);
      const run = await driveDecision(context, plan);
      const response = answerOf(f, run, 0, 'single choice');
      if (response) {
        exchangeFailures(f, plan.requests[0] as DecisionRequest, response, 'single choice');
        f.expect(Boolean(response.modelId), 'single choice: the response names no modelId');
        const count = Object.keys(response.answers).length;
        f.expect(count === 1, `single choice: ${count} answers came back for one question`);
      }
      netFailures(f, run, 'single choice');
      return f.messages;
    },
  },
  {
    name: 'the request carries every criterion key and description verbatim',
    async run(context) {
      const f = new Failures();
      const plan = choicePlan(context, [{ said: 'tell me my balance', confidence: 0.8 }], 4);
      const run = await driveDecision(context, plan);
      const wire = run.bodies.join('\n');
      for (const key of plan.keys) {
        f.expect(wire.includes(key), `criteria fidelity: the request omits criterion key ${key}`);
        f.expect(
          wire.includes(plan.question.criteria[key] ?? ''),
          `criteria fidelity: the request omits the description of criterion ${key}`,
        );
      }
      answerOf(f, run, 0, 'criteria fidelity');
      netFailures(f, run, 'criteria fidelity');
      return f.messages;
    },
  },
  {
    name: 'all three primitives are answered in one request',
    async run(context) {
      const f = new Failures();
      const { model, request, answers } = primitivesPlan(context, 'yes I can pay half on friday');
      const run = await driveDecision(context, {
        model,
        exchanges: [{ request, response: decisionReply(model, answers) }],
      });
      const response = answerOf(f, run, 0, 'three primitives');
      if (response) {
        exchangeFailures(f, request, response, 'three primitives');
        for (const [id, expected] of [
          ['q_intent', 'choice'],
          ['q_commit', 'noul'],
          ['q_willing', 'score'],
        ] as const)
          f.expect(
            response.answers[id]?.type === expected,
            `three primitives: ${id} came back as ${response.answers[id]?.type}, not ${expected}`,
          );
      }
      f.expect(
        run.bodies.length === 1,
        `three primitives: one request produced ${run.bodies.length} provider calls`,
      );
      netFailures(f, run, 'three primitives');
      return f.messages;
    },
  },
  {
    name: 'many questions in one request are answered in a single exchange',
    async run(context) {
      const f = new Failures();
      const token = runToken();
      const model = modelsOf(context)[0] as string;
      const cal = `kit-cal-${token}`;
      const questions: Record<string, DecisionQuestion> = {};
      const answers: Record<string, Record<string, unknown>> = {};
      for (let index = 0; index < 6; index += 1) {
        const id = `q_${token}_${index}`;
        const shape = choiceOf(3, `${token}_${index}`);
        questions[id] = shape.question;
        answers[id] = choiceAnswer(shape.keys, index % 3, 0.7 + index / 100, cal);
      }
      const request: DecisionRequest = {
        state: stateOf(token, `I lost my job last month (run ${token})`),
        questions,
      };
      const run = await driveDecision(context, {
        model,
        exchanges: [{ request, response: decisionReply(model, answers) }],
      });
      const response = answerOf(f, run, 0, 'batched questions');
      if (response) {
        exchangeFailures(f, request, response, 'batched questions');
        const count = Object.keys(response.answers).length;
        f.expect(count === 6, `batched questions: ${count} of 6 questions were answered`);
      }
      f.expect(
        run.bodies.length === 1,
        `batched questions: 6 questions in one request produced ${run.bodies.length} provider calls; a slot that fans out costs one round trip per question`,
      );
      netFailures(f, run, 'batched questions');
      return f.messages;
    },
  },
];

export const DECISION_CHECKS: readonly KitCheck<DecisionKitContext>[] = [
  ...EXCHANGE_CHECKS,
  ...DECISION_CONFIDENCE_CHECKS,
  ...DECISION_LIMIT_CHECKS,
  ...DECISION_NEGATIVE_CHECKS,
];
