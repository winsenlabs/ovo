import type {
  AgentDecisionPolicy,
  AgentDecisionQuestion,
  DecisionFallback,
  DecisionOutcome,
} from './agent-decision.ts';
import type { DecisionAnswer, DecisionQuestion, DecisionRequest } from './decision.ts';

/**
 * Turning an authored policy into a request, and an answer back into an outcome. Separate from the
 * schemas in `agent-decision.ts` because this is the only code that crosses the authoring/wire line,
 * and it must stay pure: it applies the threshold and reports, it never performs the effect.
 */

/** The model-facing payload for one authored question. Outcomes and thresholds are stripped. */
export function decisionQuestionPayload(question: AgentDecisionQuestion): DecisionQuestion {
  if (question.type === 'choice')
    return {
      type: 'choice',
      instructions: question.instructions,
      criteria: Object.fromEntries(
        question.options.map((option) => [option.key, option.description]),
      ),
    };
  if (question.type === 'noul')
    return {
      type: 'noul',
      instructions: question.instructions,
      criteria: { yes: question.yes.description, no: question.no.description },
    };
  return { type: 'score', instructions: question.instructions, criteria: [...question.rubric] };
}

/** One round trip for every authored question. */
export function compileDecisionRequest(
  policy: AgentDecisionPolicy,
  state: DecisionRequest['state'],
): DecisionRequest {
  return {
    state,
    questions: Object.fromEntries(
      policy.questions.map((question) => [question.id, decisionQuestionPayload(question)]),
    ),
  };
}

export type DecisionResolution =
  | {
      used: true;
      questionId: string;
      outcome: DecisionOutcome;
      /** The answer as the model gave it, for the transcript and the disposition log. */
      answer: DecisionAnswer;
      /** Whether the answer matched what the operator expected. Undefined when none was authored. */
      asExpected?: boolean;
    }
  | {
      used: false;
      questionId: string;
      reason: 'below-threshold';
      fallback: DecisionFallback;
      confidence: number;
      threshold: number;
      answer: DecisionAnswer;
    };

/**
 * Apply the authored threshold and map a trusted answer to its outcome. Pure: the caller performs
 * the effect. A mismatched answer type is a programming error, not a low-confidence answer, so it
 * throws rather than silently falling back.
 */
export function resolveDecision(
  question: AgentDecisionQuestion,
  answer: DecisionAnswer,
): DecisionResolution {
  if (question.type !== answer.type)
    throw new Error(
      `Decision answer for ${question.id} is a ${answer.type}, but the question is a ${question.type}`,
    );
  if (answer.confidence < question.threshold)
    return {
      used: false,
      questionId: question.id,
      reason: 'below-threshold',
      fallback: question.fallback,
      confidence: answer.confidence,
      threshold: question.threshold,
      answer,
    };
  if (question.type === 'choice' && answer.type === 'choice') {
    const option = question.options.find((candidate) => candidate.key === answer.choice);
    if (!option)
      throw new Error(`Decision chose ${answer.choice}, which ${question.id} does not offer`);
    return {
      used: true,
      questionId: question.id,
      outcome: option.outcome,
      answer,
      ...(question.expected === undefined
        ? {}
        : { asExpected: answer.choice === question.expected }),
    };
  }
  if (question.type === 'noul' && answer.type === 'noul') {
    const yes = answer.noul >= 0.5;
    return {
      used: true,
      questionId: question.id,
      outcome: yes ? question.yes.outcome : question.no.outcome,
      answer,
      ...(question.expected === undefined
        ? {}
        : { asExpected: (yes ? 'yes' : 'no') === question.expected }),
    };
  }
  if (question.type === 'score' && answer.type === 'score') {
    // Highest band at or below the score. A band at 0 is required, so this always finds one.
    const band = [...question.bands]
      .sort((left, right) => right.atLeast - left.atLeast)
      .find((candidate) => answer.score >= candidate.atLeast)!;
    return {
      used: true,
      questionId: question.id,
      outcome: band.outcome,
      answer,
      ...(question.expectedAtLeast === undefined
        ? {}
        : { asExpected: answer.score >= question.expectedAtLeast }),
    };
  }
  throw new Error(`Unreachable decision answer shape for ${question.id}`);
}
