import { z } from 'zod';

/**
 * Per-agent decision authoring. `decision.ts` holds the provider-neutral wire contract; this holds
 * what an operator configures in the console — the questions, the allowed answers, the answer the
 * operator expects, the outcome each answer produces, and the confidence below which the answer is
 * not used at all.
 *
 * The authored shape is deliberately NOT the wire shape. An author thinks "here are the options and
 * here is what each one means"; the model is sent only the options and their descriptions. The
 * outcomes, expectations and thresholds never reach the model, so they cannot influence the answer
 * they are judging. `decisionQuestionPayload` is the only bridge, and it is pure.
 */

/** Shares the wire grammar: a question id, and a choice option key, are the same kind of token. */
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const Prose = z.string().trim().min(1).max(2_000);
const Probability = z.number().finite().min(0).max(1);

/**
 * What the call does once an answer is trusted. An outcome that does nothing is a configuration
 * mistake that would be invisible at runtime, so it fails authoring instead.
 */
export const DecisionOutcome = z
  .object({
    /**
     * Spoken verbatim, skipping the LLM entirely — the latency win a decision model buys. Absent
     * means this branch records its answer and lets the LLM compose the reply.
     */
    say: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

/*
 * A business disposition (`promise_to_pay:tomorrow`) and a script jump are the two other outcomes
 * this shape obviously wants, and neither is here, because neither can act today:
 *
 *   - `EventSink` and `HumanHandoffPort` are declared in `contracts/src/ports.ts` and
 *     `human-handoff.ts` with no implementation and no caller anywhere in this repository, and
 *     `TranscriptObserver` accepts only `user.transcript` and `agent.transcript`. There is no
 *     durable sink a behaviour can write a disposition to.
 *   - A script jump needs a router. `AgentConfig` already refuses a script outside announcement and
 *     FAQ mode, so an agent-mode decision has no graph to jump in.
 *
 * Both are named open items (`PM/CURRENT-STATE.md` item 8, and P2 for the intent graph). An outcome
 * field that validates and then does nothing is worse than its absence, so they wait for those.
 */
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

/**
 * What happens when confidence falls below the authored threshold. `llm` is the documented Jev
 * posture — the decision model answers what it is confident about and defers the rest.
 *
 * `handoff` is deliberately absent. `HumanHandoffPort` is a contract with no implementation and no
 * caller anywhere in this repository, so a `handoff` fallback would be a configuration that reads
 * as a safety net and does nothing. It arrives with that port, not before.
 */
export const DecisionFallback = z.enum(['llm', 'clarify']);
export type DecisionFallback = z.infer<typeof DecisionFallback>;

const ChoiceOption = z
  .object({
    key: Id,
    /** Sent to the model as this option's description. The only authored text the model sees. */
    description: Prose,
    outcome: DecisionOutcome,
  })
  .strict();

const ScoreBand = z
  .object({
    atLeast: z.number().finite().min(0),
    outcome: DecisionOutcome,
  })
  .strict();

const Shared = {
  id: Id,
  /** Operator's note on why the question exists. Never sent to the model. */
  purpose: z.string().trim().max(500).default(''),
  /** The question text sent to the model. */
  instructions: Prose,
  /** Below this confidence the answer is discarded and `fallback` runs. */
  threshold: Probability,
  fallback: DecisionFallback,
};

export const AgentDecisionQuestion = z.discriminatedUnion('type', [
  z
    .object({
      ...Shared,
      type: z.literal('choice'),
      options: z.array(ChoiceOption).min(2).max(255),
      /** The option the operator expects. Recorded for drift review; never sent to the model. */
      expected: Id.optional(),
    })
    .strict()
    .refine(
      (question) =>
        new Set(question.options.map((option) => option.key)).size === question.options.length,
      { message: 'Choice option keys must be unique', path: ['options'] },
    )
    .refine(
      (question) =>
        !question.expected || question.options.some((option) => option.key === question.expected),
      { message: 'Expected answer must be one of the options', path: ['expected'] },
    ),
  z
    .object({
      ...Shared,
      type: z.literal('noul'),
      yes: z.object({ description: Prose, outcome: DecisionOutcome }).strict(),
      no: z.object({ description: Prose, outcome: DecisionOutcome }).strict(),
      expected: z.enum(['yes', 'no']).optional(),
    })
    .strict(),
  z
    .object({
      ...Shared,
      type: z.literal('score'),
      /** Rubric levels, lowest first. The model scores against their indices. */
      rubric: z.array(Prose).min(2).max(10),
      /** Bands over the weighted score. One must start at 0 so every score resolves. */
      bands: z.array(ScoreBand).min(1).max(10),
      expectedAtLeast: z.number().finite().min(0).optional(),
    })
    .strict()
    .refine((question) => question.bands.some((band) => band.atLeast === 0), {
      message: 'Score bands must include one starting at 0 so every score resolves',
      path: ['bands'],
    })
    .refine(
      (question) =>
        new Set(question.bands.map((band) => band.atLeast)).size === question.bands.length,
      { message: 'Score band thresholds must be distinct', path: ['bands'] },
    )
    .refine(
      (question) => question.bands.every((band) => band.atLeast <= question.rubric.length - 1),
      {
        message: 'A score band above the highest rubric index can never be reached',
        path: ['bands'],
      },
    )
    .refine(
      (question) =>
        question.expectedAtLeast === undefined ||
        question.expectedAtLeast <= question.rubric.length - 1,
      { message: 'Expected score is above the highest rubric index', path: ['expectedAtLeast'] },
    ),
]);
export type AgentDecisionQuestion = z.infer<typeof AgentDecisionQuestion>;

/**
 * What the model is shown. A decision can only be grounded in what is listed here, so the list is
 * explicit rather than "everything available": an operator who adds a question about a document has
 * to also say where that document comes from.
 */
export const DECISION_STATE_SOURCES = [
  'last-turn',
  'transcript',
  'variables',
  'context',
  /** Passages the `knowledge` plugin retrieved for this turn. Empty when nothing cleared the bar. */
  'knowledge',
] as const;
export const DecisionStateSource = z.enum(DECISION_STATE_SOURCES);
export type DecisionStateSource = z.infer<typeof DecisionStateSource>;

export const AgentDecisionPolicy = z
  .object({
    enabled: z.boolean().default(false),
    /** Asked together in one round trip. Separate questions do not cost separate calls. */
    questions: z.array(AgentDecisionQuestion).min(1).max(32),
    state: z
      .object({
        sources: z.array(DecisionStateSource).min(1),
        transcriptTurns: z.number().int().min(1).max(50).default(6),
      })
      .strict()
      .refine(
        (state) => new Set(state.sources).size === state.sources.length,
        'State sources must be unique',
      ),
    /**
     * Milliseconds the decision may take before the turn gives up and runs the fallback. A decision
     * sits in front of the reply, so its latency is audible.
     */
    timeoutMs: z.number().int().min(50).max(10_000).default(1_500),
  })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.questions.map((question) => question.id)).size === policy.questions.length,
    { message: 'Decision question ids must be unique', path: ['questions'] },
  );
export type AgentDecisionPolicy = z.infer<typeof AgentDecisionPolicy>;
