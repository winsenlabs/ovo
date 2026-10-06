import { z } from 'zod';

/**
 * Provider-neutral decision contract. Its three primitives mirror the published TypeSafe
 * System One question/answer shapes; adapters for Jev, Laya and other models belong later.
 * https://api.typesafe.ai/openapi.json
 */
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const Description = z.string().trim().min(1).max(2_000);
const Probability = z.number().finite().min(0).max(1);
// Score rubrics use numeric index keys, so the answer map cannot use the question-id grammar.
const Probabilities = z.record(z.string().min(1), Probability);

export const DecisionQuestion = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('choice'),
      instructions: Description,
      criteria: z.record(Id, Description).refine((value) => {
        const count = Object.keys(value).length;
        return count >= 2 && count <= 255;
      }, 'Choice needs 2–255 described options'),
    })
    .strict(),
  z
    .object({
      type: z.literal('noul'),
      instructions: Description,
      criteria: z.object({ yes: Description, no: Description }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('score'),
      instructions: Description,
      criteria: z.array(Description).min(2).max(10),
    })
    .strict(),
]);
export type DecisionQuestion = z.infer<typeof DecisionQuestion>;

export const DecisionRequest = z
  .object({
    state: z.union([
      z.string().min(1),
      z.record(z.string(), z.unknown()),
      z.array(z.unknown()).min(1),
    ]),
    questions: z
      .record(Id, DecisionQuestion)
      .refine(
        (value) => Object.keys(value).length > 0,
        'At least one decision question is required',
      ),
  })
  .strict();
export type DecisionRequest = z.infer<typeof DecisionRequest>;

const AnswerBase = {
  /** Confidence must come from a measured calibration cohort, identified by this version. */
  confidence: Probability,
  calibrationVersion: z.string().min(1).max(120),
  probabilities: Probabilities,
};
export const DecisionAnswer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: Id, ...AnswerBase }).strict(),
  z.object({ type: z.literal('noul'), noul: Probability, ...AnswerBase }).strict(),
  z.object({ type: z.literal('score'), score: z.number().finite(), ...AnswerBase }).strict(),
]);
export type DecisionAnswer = z.infer<typeof DecisionAnswer>;

export const DecisionResponse = z
  .object({
    modelId: z.string().min(1),
    answers: z
      .record(Id, DecisionAnswer)
      .refine((value) => Object.keys(value).length > 0, 'At least one decision answer is required'),
  })
  .strict();
export type DecisionResponse = z.infer<typeof DecisionResponse>;

/** Checks the parts a standalone response cannot know about the request. */
export function validateDecisionExchange(
  rawRequest: unknown,
  rawResponse: unknown,
): { request: DecisionRequest; response: DecisionResponse } {
  const request = DecisionRequest.parse(rawRequest);
  const response = DecisionResponse.parse(rawResponse);
  const questionIds = Object.keys(request.questions).sort();
  if (JSON.stringify(questionIds) !== JSON.stringify(Object.keys(response.answers).sort()))
    throw new Error('Decision answers must match requested questions');
  for (const id of questionIds) {
    const question = request.questions[id]!;
    const answer = response.answers[id]!;
    if (question.type !== answer.type) throw new Error(`Decision answer type differs for ${id}`);
    const expected =
      question.type === 'choice'
        ? Object.keys(question.criteria)
        : question.type === 'noul'
          ? ['yes', 'no']
          : question.criteria.map((_, index) => String(index));
    if (
      JSON.stringify(expected.sort()) !== JSON.stringify(Object.keys(answer.probabilities).sort())
    )
      throw new Error(`Decision probabilities do not cover criteria for ${id}`);
    const total = Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > 0.01)
      throw new Error(`Decision probabilities are not normalized for ${id}`);
    if (answer.type === 'choice') {
      const chosen = answer.probabilities[answer.choice];
      if (chosen === undefined || chosen < Math.max(...Object.values(answer.probabilities)) - 0.001)
        throw new Error(`Decision choice is not the highest-probability option for ${id}`);
    } else if (answer.type === 'noul') {
      if (Math.abs(answer.noul - answer.probabilities.yes!) > 0.01)
        throw new Error(`Decision noul differs from yes probability for ${id}`);
    } else {
      const weighted = Object.entries(answer.probabilities).reduce(
        (sum, [level, value]) => sum + Number(level) * value,
        0,
      );
      if (Math.abs(answer.score - weighted) > 0.01)
        throw new Error(`Decision score differs from rubric probabilities for ${id}`);
    }
  }
  return { request, response };
}

/**
 * Where in the conversation a decision was asked, for telemetry only. A port must not send it to
 * the model or let it change the answer: the request alone is what the model judges.
 */
export interface DecisionTrace {
  flow?: { node?: string; listen: string };
}

export interface DecisionPort {
  decide(
    request: DecisionRequest,
    options: { signal: AbortSignal; trace?: DecisionTrace },
  ): Promise<DecisionResponse>;
}
