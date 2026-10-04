/**
 * The vocabulary of the `decision@1` kit: the script plan a provider template renders, the kit's
 * factory and options, per-run criteria generation, the three primitive question builders and the
 * canonical answer builders.
 *
 * A GREEN KIT DOES NOT MEAN THE CONFIDENCE NUMBER IS CALIBRATED. A fixture returns whatever it is
 * scripted to return. The kit proves faithful pass-through, criteria fidelity, one-request
 * batching, calibration provenance, that confidence moves with the input, and refusal of malformed
 * answers. Measuring calibration needs recorded responses over real transcripts and is a separate,
 * founder-gated exercise; no check here substitutes for it.
 */
import type {
  Clock,
  DecisionPort,
  DecisionQuestion,
  DecisionRequest,
  NetFixtureScript,
  NetFixtureStep,
  NetPort,
  UsageSink,
} from '@winsendotai/ovo-contracts';

/** One scripted request/response pair. `response` is a raw record so a negative can malform it. */
export interface DecisionPlannedExchange {
  request: DecisionRequest;
  response: Record<string, unknown>;
  /** A scripted delay before the reply, so an abort can land mid-flight. */
  delayMs?: number;
}

export interface DecisionScriptPlan {
  /** The model the port under test is bound to; the kit binds each `options.models` entry. */
  model: string;
  exchanges: readonly DecisionPlannedExchange[];
}

/** A provider package turns the kit's plan into its own documented wire script (§12). */
export type DecisionTemplate = (plan: DecisionScriptPlan) => NetFixtureScript[];

export type DecisionFactory = (env: {
  net: NetPort;
  clock: Clock;
  usage: UsageSink;
  /** The model the port must bind. The kit binds two, to pin the calibration cohort to one. */
  model: string;
}) => DecisionPort | Promise<DecisionPort>;

export interface DecisionKitOptions {
  template?: DecisionTemplate;
  /**
   * Models the factory can bind, each with its OWN measured calibration cohort. At least two: a
   * `calibrationVersion` that cannot tell two models apart identifies no cohort at all.
   */
  models?: readonly string[];
}

export interface DecisionKitContext {
  factory: DecisionFactory;
  options: DecisionKitOptions;
}

export const KIT_MODELS = ['kit-decision-a', 'kit-decision-b'] as const;

let runs = 0;

/** A per-run token. Criteria keys and descriptions carry it, so nothing can be hardcoded. */
export const runToken = (): string => `${Date.now().toString(36)}${(++runs).toString(36)}`;

export interface ChoiceShape {
  keys: string[];
  question: Extract<DecisionQuestion, { type: 'choice' }>;
}

export function choiceOf(count: number, token: string): ChoiceShape {
  const keys = Array.from({ length: count }, (_, index) => `opt_${token}_${index}`);
  const criteria = Object.fromEntries(
    keys.map((key) => [key, `the caller means ${key}, as described in run ${token}`]),
  );
  return {
    keys,
    question: {
      type: 'choice',
      instructions: `pick the option the caller means (run ${token})`,
      criteria,
    },
  };
}

export const noulOf = (token: string): Extract<DecisionQuestion, { type: 'noul' }> => ({
  type: 'noul',
  instructions: `did the caller commit to paying (run ${token})`,
  criteria: {
    yes: `the caller committed to paying, per run ${token}`,
    no: `the caller refused to commit, per run ${token}`,
  },
});

export const scoreOf = (token: string): Extract<DecisionQuestion, { type: 'score' }> => ({
  type: 'score',
  instructions: `rate how willing the caller sounds (run ${token})`,
  criteria: [
    `not willing at all, per run ${token}`,
    `somewhat willing, per run ${token}`,
    `fully willing, per run ${token}`,
  ],
});

/** A probability vector over `keys` whose mass sits on `winner` and which sums to 1. */
export function vector(keys: readonly string[], winner: number, top = 0.6): Record<string, number> {
  const rest = keys.length > 1 ? (1 - top) / (keys.length - 1) : 0;
  return Object.fromEntries(keys.map((key, index) => [key, index === winner ? top : rest]));
}

export const choiceAnswer = (
  keys: readonly string[],
  winner: number,
  confidence: number,
  calibrationVersion: string,
): Record<string, unknown> => ({
  type: 'choice',
  choice: keys[winner],
  confidence,
  calibrationVersion,
  probabilities: vector(keys, winner),
});

export const noulAnswer = (
  yes: number,
  confidence: number,
  calibrationVersion: string,
): Record<string, unknown> => ({
  type: 'noul',
  noul: yes,
  confidence,
  calibrationVersion,
  probabilities: { yes, no: 1 - yes },
});

/** `levels` is the per-rubric-index probability vector; the score is its weighted sum. */
export const scoreAnswer = (
  levels: readonly number[],
  confidence: number,
  calibrationVersion: string,
): Record<string, unknown> => ({
  type: 'score',
  score: levels.reduce((sum, probability, index) => sum + index * probability, 0),
  confidence,
  calibrationVersion,
  probabilities: Object.fromEntries(
    levels.map((probability, index) => [String(index), probability]),
  ),
});

/** A well-formed provider reply: the bound model, echoed back, and one answer per question. */
export const decisionReply = (
  model: string,
  answers: Record<string, Record<string, unknown>>,
): Record<string, unknown> => ({ modelId: model, answers });

/** A `where` map requiring every criterion key and description of `request` in the body. */
export function decisionCriteriaWhere(request: DecisionRequest): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    where[`questions.${id}.type`] = question.type;
    const entries =
      question.type === 'score'
        ? question.criteria.map((text, index) => [String(index), text] as const)
        : Object.entries(question.criteria);
    for (const [key, text] of entries) where[`questions.${id}.criteria.${key}`] = text;
  }
  return where;
}

export const decisionHttpStep = (
  url: string,
  where: Record<string, unknown>,
  body: string,
): NetFixtureStep => ({
  expect: 'http',
  method: 'POST',
  url,
  body: 'json',
  where,
  reply: { status: 200, headers: { 'content-type': 'application/json' }, body },
});

export const modelsOf = (context: DecisionKitContext): readonly string[] =>
  context.options.models ?? KIT_MODELS;

/** The conversational state a check sends; `said` is what the kit pretends the caller replied. */
export const stateOf = (token: string, said: string): Record<string, unknown> => ({
  caller_reply: said,
  agent_last_said: `when would you like to pay? (run ${token})`,
  language: 'en-IN',
});

/** What a check wants one scripted turn to look like. */
export interface ChoiceTurn {
  said: string;
  confidence?: number;
  winner?: number;
}

export interface ChoicePlan {
  token: string;
  model: string;
  keys: string[];
  question: Extract<DecisionQuestion, { type: 'choice' }>;
  requests: DecisionRequest[];
  exchanges: DecisionPlannedExchange[];
}

/**
 * The shape most checks need: one `choice` question asked over one state per turn, with the
 * faithful reply already scripted. Each call mints a fresh run token, so no two checks share
 * criteria keys and no plugin can answer from a cache.
 */
export function choicePlan(
  context: DecisionKitContext,
  turns: readonly ChoiceTurn[],
  optionCount = 3,
): ChoicePlan {
  const token = runToken();
  const model = modelsOf(context)[0] as string;
  const { keys, question } = choiceOf(optionCount, token);
  const requests = turns.map((turn) => ({
    state: stateOf(token, `${turn.said} (run ${token})`),
    questions: { q_intent: question },
  }));
  const exchanges = turns.map((turn, index) => ({
    request: requests[index] as DecisionRequest,
    response: decisionReply(model, {
      q_intent: choiceAnswer(keys, turn.winner ?? 0, turn.confidence ?? 0.85, `kit-cal-${token}`),
    }),
  }));
  return { token, model, keys, question, requests, exchanges };
}

export interface PrimitivesPlan {
  token: string;
  model: string;
  keys: string[];
  request: DecisionRequest;
  answers: Record<string, Record<string, unknown>>;
}

/** One request carrying all three primitives, with a faithful answer for each. */
export function primitivesPlan(context: DecisionKitContext, said: string): PrimitivesPlan {
  const token = runToken();
  const model = modelsOf(context)[0] as string;
  const { keys, question } = choiceOf(3, token);
  const cal = `kit-cal-${token}`;
  return {
    token,
    model,
    keys,
    request: {
      state: stateOf(token, `${said} (run ${token})`),
      questions: { q_intent: question, q_commit: noulOf(token), q_willing: scoreOf(token) },
    },
    answers: {
      q_intent: choiceAnswer(keys, 0, 0.88, cal),
      q_commit: noulAnswer(0.7, 0.64, cal),
      q_willing: scoreAnswer([0.1, 0.3, 0.6], 0.55, cal),
    },
  };
}
