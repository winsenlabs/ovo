/**
 * The refusal half of `decision@1`. Each check scripts ONE deliberately malformed provider reply
 * and requires `decide()` to REJECT it. A plugin that repairs the reply (renormalizing, picking the
 * argmax itself, synthesizing a probability vector or defaulting a calibration version) resolves,
 * and resolving is the failure: a repaired answer hides a broken model behind a plausible number.
 */
import { driveDecision, refusalFailures } from './decision-harness.ts';
import {
  decisionReply,
  noulAnswer,
  primitivesPlan,
  type DecisionKitContext,
} from './decision-support.ts';
import { Failures, type KitCheck } from './runner.ts';

type Answers = Record<string, Record<string, unknown>>;

interface DecisionNegative {
  /** The stable check name. */
  name: string;
  /** The short label every failure message carries. */
  what: string;
  corrupt(answers: Answers, keys: readonly string[]): void;
}

const probabilitiesOf = (answer: Record<string, unknown>): Record<string, number> =>
  answer.probabilities as Record<string, number>;

const NEGATIVES: readonly DecisionNegative[] = [
  {
    name: 'unnormalized probabilities are refused',
    what: 'unnormalized probabilities',
    corrupt(answers, keys) {
      const probabilities = probabilitiesOf(answers.q_intent as Record<string, unknown>);
      for (const key of keys) probabilities[key] = (probabilities[key] ?? 0) * 1.4;
    },
  },
  {
    name: 'probabilities that do not cover the requested criteria are refused',
    what: 'criteria coverage',
    corrupt(answers) {
      (answers.q_intent as Record<string, unknown>).probabilities = { 0: 0.2, 1: 0.2, 2: 0.6 };
    },
  },
  {
    name: 'a choice that is not the highest-probability option is refused',
    what: 'argmax',
    corrupt(answers, keys) {
      (answers.q_intent as Record<string, unknown>).choice = keys[1];
    },
  },
  {
    name: 'a noul that disagrees with its own yes probability is refused',
    what: 'noul agreement',
    corrupt(answers) {
      const answer = answers.q_commit as Record<string, unknown>;
      answer.noul = probabilitiesOf(answer).no;
    },
  },
  {
    name: 'a score that is not the probability-weighted rubric is refused',
    what: 'score rubric',
    corrupt(answers) {
      const answer = answers.q_willing as Record<string, unknown>;
      answer.score = (answer.score as number) * 2 + 1;
    },
  },
  {
    name: 'an answer to a question that was not asked is refused',
    what: 'unasked question',
    corrupt(answers) {
      answers.q_not_asked = { ...(answers.q_intent as Record<string, unknown>) };
    },
  },
  {
    name: 'a missing answer is refused',
    what: 'missing answer',
    corrupt(answers) {
      delete answers.q_willing;
    },
  },
  {
    name: 'an answer of the wrong primitive type is refused',
    what: 'primitive type',
    corrupt(answers) {
      const cal = String((answers.q_intent as Record<string, unknown>).calibrationVersion);
      answers.q_intent = noulAnswer(0.7, 0.8, cal);
    },
  },
  {
    name: 'an answer without calibrationVersion is refused',
    what: 'calibration provenance',
    corrupt(answers) {
      for (const answer of Object.values(answers)) delete answer.calibrationVersion;
    },
  },
];

function negativeCheck(negative: DecisionNegative): KitCheck<DecisionKitContext> {
  return {
    name: negative.name,
    async run(context) {
      const f = new Failures();
      const { model, keys, request, answers } = primitivesPlan(context, 'a reply to be corrupted');
      negative.corrupt(answers, keys);
      const run = await driveDecision(context, {
        model,
        exchanges: [{ request, response: decisionReply(model, answers) }],
      });
      refusalFailures(f, run, 0, negative.what);
      f.add(...run.net.mismatches.map((error) => `${negative.what}: ${error.message}`));
      f.expect(
        run.attempts.length === 0,
        `${negative.what}: network bypassed the NetPort: ${run.attempts.join(', ')}`,
      );
      return f.messages;
    },
  };
}

export const DECISION_NEGATIVE_CHECKS: readonly KitCheck<DecisionKitContext>[] =
  NEGATIVES.map(negativeCheck);
