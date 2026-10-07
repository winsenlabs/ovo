import { z } from 'zod';
import { AgentFlow } from './agent-flow.ts';

// The flow is authored inside the decision policy, so it is exported alongside it.
export * from './agent-flow.ts';

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
    /**
     * End the call once this turn's reply has played: `say` when set, otherwise the LLM's reply.
     * The call ends `completed`; a caller who barges in on the goodbye keeps it open.
     */
    end: z.boolean().optional(),
  })
  .strict();

/*
 * A business disposition (`promise_to_pay:tomorrow`) and a jump to another state are deliberately
 * not flat outcomes. Both need conversation state, and the flat policy has none: it asks the same
 * questions on every turn. They live on the flow (`agent-flow.ts`), whose nodes carry a
 * `disposition` and whose intents name the `next` node. A flat outcome stays a single reply.
 */
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

/**
 * What happens when confidence falls below the authored threshold. `llm` is the documented Jev
 * posture — the decision model answers what it is confident about and defers the rest.
 *
 * `handoff` is deliberately not a fallback here: a transfer is the agent's `handoff` block (AGT-15),
 * triggered by flow nodes, an unavailable decision, exhausted re-asks or the LLM tool.
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
  /** The agent's last played line: what the caller is most likely answering. */
  'agent-last-said',
  /** Today's date in the agent's timezone, so a relative date ("tomorrow") can be resolved. */
  'today',
] as const;
export const DecisionStateSource = z.enum(DECISION_STATE_SOURCES);
export type DecisionStateSource = z.infer<typeof DecisionStateSource>;

export const AgentDecisionPolicy = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Asked together in one round trip. Separate questions do not cost separate calls. Empty when
     * a `flow` routes the agent, or when a script uses the decision model only to match replies to
     * its transitions; the release check requires one of the two in agent mode.
     */
    questions: z.array(AgentDecisionQuestion).max(32).default([]),
    /** The state-aware flow (AGT-1). It replaces `questions`: one listen set is asked per turn. */
    flow: AgentFlow.optional(),
    /**
     * What the model is shown. A flow always sends the caller's reply, the agent's last line, the
     * recent turns and today; `variables`, `context` and `knowledge` add to that when listed.
     */
    state: z
      .object({
        sources: z.array(DecisionStateSource).min(1),
        transcriptTurns: z.number().int().min(1).max(50).default(6),
      })
      .strict()
      .refine(
        (state) => new Set(state.sources).size === state.sources.length,
        'State sources must be unique',
      )
      .default({ sources: ['last-turn'], transcriptTurns: 6 }),
    /**
     * Milliseconds the decision may take before the turn gives up and runs the fallback. A decision
     * sits in front of the reply, so its latency is audible. Jev answers in ~300ms on a warm
     * connection; 800ms relies on LAT-8's keep-alive and session pre-warm so a cold TLS handshake
     * from Mumbai does not turn into an `unavailable` verdict.
     */
    timeoutMs: z.number().int().min(50).max(10_000).default(800),
    /**
     * How far the agent works ahead of the caller (LAT-3, LAT-4). An absent field keeps the
     * behaviour's default (`DEFAULT_SPECULATION`): decisions on partial transcripts on, after a
     * 150ms debounce and on exactly the same words; the LLM asked alongside the decision on (the
     * calls it aborts are still billed; `llm: false` turns it off).
     */
    speculation: z
      .object({
        partials: z.boolean().optional(),
        debounceMs: z.number().int().min(0).max(2_000).optional(),
        match: z.enum(['exact', 'prefix']).optional(),
        llm: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.questions.map((question) => question.id)).size === policy.questions.length,
    { message: 'Decision question ids must be unique', path: ['questions'] },
  )
  // Asking both would leave two answers to one turn and no rule for which one speaks.
  .refine((policy) => !(policy.flow && policy.questions.length), {
    message: 'A flow replaces the decision questions; configure one or the other',
    path: ['flow'],
  });
export type AgentDecisionPolicy = z.infer<typeof AgentDecisionPolicy>;
