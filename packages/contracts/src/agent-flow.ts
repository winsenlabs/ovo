import { z } from 'zod';

/**
 * A state-aware decision flow (AGT-1): the conversation map an agent follows, authored as data.
 *
 * NODES are what the agent does on entering a state: the lines it speaks, whether the call ends
 * there, the disposition it records, and which LISTEN set interprets the caller's next reply.
 * LISTENS are the intents a reply can mean at that point, each with the description the decision
 * model reads and the node it leads to. GLOBAL intents ("stop calling me", "who is this") are
 * offered in every listening state, and an automatic `other` bucket is always added, so the model
 * is never forced to pick a branch that does not fit.
 *
 * One decision request per caller turn asks only the current listen set (plus the globals and
 * `other`), so the model chooses among the handful of options that make sense right now instead
 * of every option the agent has. That is the difference from the flat `questions` policy, which
 * sends everything on every turn and never knows what the agent just asked.
 *
 * The schema checks shape only. Graph rules (unknown targets, unreachable nodes, duplicate intents,
 * undeclared variables) are reported by `compileFlow` and become release blockers, so a draft that
 * is still being wired up can be saved.
 */

/** Intent and slot keys travel as choice criteria keys, so they share the decision wire grammar. */
const Key = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const Prose = z.string().trim().min(1).max(2_000);
/** A spoken line. `{{path}}` renders from the call's variables, as every agent template does. */
const Line = z.string().trim().min(1).max(1_000);
const Phrase = z.string().trim().min(1).max(200);

/** The automatic "none of these" criterion, added to every listen set. An intent cannot use it. */
export const FLOW_OTHER_INTENT = 'other';
/** The question id the listen set's intents are asked under; a slot cannot reuse it. */
export const FLOW_INTENT_QUESTION = 'intent';
export const FLOW_OTHER_DESCRIPTION =
  'None of the above fits: a question, a new topic, or anything the listed options do not cover';
/** The tool the LLM fallback calls to say its reply and pick where the flow resumes (AGT-7). */
export const FLOW_RESUME_TOOL_ID = 'resume_flow';
/** A `resume_at` that ends the call after the LLM's reply. */
export const FLOW_RESUME_END = 'end';
export const DEFAULT_FLOW_THRESHOLD = 0.55;

/**
 * Release-blocking codes the flow raises. `contracts/src/blockers.ts` spreads these into
 * `COMPAT_CODES`, so a code is spelled once.
 */
export const FLOW_COMPAT_CODES = ['flow_invalid', 'decision_mode_unsupported'] as const;
export type FlowCompatCode = (typeof FLOW_COMPAT_CODES)[number];

/**
 * A detail asked in the same round trip as the intent, such as "by when will they pay". It costs
 * no extra latency: the model answers every question of one request on the same state.
 */
export const FlowSlot = z
  .object({
    id: Key,
    question: Prose,
    options: z
      .array(z.object({ key: Key, description: Prose }).strict())
      .min(2)
      .max(32),
  })
  .strict();
export type FlowSlot = z.infer<typeof FlowSlot>;

/** A node id, or a choice of node by a slot's answer with a node for anything else. */
export const FlowRoute = z.union([
  Key,
  z
    .object({
      slot: Key,
      cases: z.record(Key, Key),
      otherwise: Key,
    })
    .strict(),
]);
export type FlowRoute = z.infer<typeof FlowRoute>;

export const FlowIntent = z
  .object({
    key: Key,
    /** Sent to the decision model as this option's description. */
    description: Prose,
    /**
     * Whole replies that mean this intent with no decision call at all ("yes", "haan ji"). Matched
     * after normalisation (case, punctuation and spacing), never as a pattern, so a phrase cannot
     * take the call down with a pathological expression.
     */
    phrases: z.array(Phrase).max(100).default([]),
    /** Where the conversation goes. Exactly one of `next` and `repeat` is set. */
    next: FlowRoute.optional(),
    /** Say the agent's last lines again instead of moving ("sorry, what?"). */
    repeat: z.boolean().optional(),
  })
  .strict();
export type FlowIntent = z.infer<typeof FlowIntent>;

export const FlowListen = z
  .object({
    id: Key,
    /**
     * What the decision model is asked about the reply, given what the agent just said: "The agent
     * asked to confirm who picked up. How did they respond in `caller_reply`?"
     */
    question: Prose,
    intents: z.array(FlowIntent).min(1).max(64),
    slots: z.array(FlowSlot).max(8).default([]),
  })
  .strict();
export type FlowListen = z.infer<typeof FlowListen>;

export const FlowNode = z
  .object({
    id: Key,
    /**
     * Line ids spoken in order on entering the node. A node with none lets the LLM compose the
     * reply; the flow still listens with the node's listen set afterwards.
     */
    say: z.array(Key).max(10).default([]),
    /** The listen set that interprets the caller's next reply. Every node that does not end has one. */
    listen: Key.optional(),
    /** The call ends once this node's lines have played (a caller who barges in keeps it open). */
    end: z.boolean().default(false),
    /** The business outcome recorded on entering the node, such as `promise_to_pay:tomorrow`. */
    disposition: z
      .string()
      .regex(/^[a-z][a-z0-9_:.-]{0,119}$/)
      .optional(),
    /**
     * Entering the node confirms who the agent is speaking with. While a flow has such a node and
     * none has been entered, the LLM fallback is not shown the call's facts.
     */
    verified: z.boolean().default(false),
  })
  .strict();
export type FlowNode = z.infer<typeof FlowNode>;

export const AgentFlow = z
  .object({
    version: z.literal(1).default(1),
    start: Key,
    /** Background the decision model reads with every question: who is calling whom, and why. */
    context: Prose.optional(),
    /** Every line the flow can speak, by id. A line without a placeholder can be pre-rendered. */
    lines: z.record(Key, Line).default({}),
    nodes: z.array(FlowNode).min(1).max(200),
    listens: z.array(FlowListen).max(100).default([]),
    /** Offered in every listening state, after the state's own intents. */
    globalIntents: z.array(FlowIntent).max(16).default([]),
    /** Below this confidence an intent is not trusted and `fallback` runs. */
    threshold: z.number().finite().min(0).max(1).default(DEFAULT_FLOW_THRESHOLD),
    /**
     * What a reply that fits nothing does (`other`, low confidence, or no decision available):
     * `llm` answers it and rejoins the flow; `clarify` asks again and stays put, with no LLM.
     */
    fallback: z.enum(['llm', 'clarify']).default('llm'),
    /** Spoken when `fallback` is `clarify`. The agent's clarification line when absent. */
    clarify: Key.optional(),
    /** Spoken before the replayed lines of a `repeat` intent. */
    repeatPrefix: Key.optional(),
  })
  .strict();
export type AgentFlow = z.infer<typeof AgentFlow>;

/** Where a session is: the node it last entered and the listen set waiting for the next reply. */
export interface FlowPosition {
  node?: string;
  listen?: string;
}

/** How a turn moved the flow. Bounded per session and never carries variable values. */
export interface FlowTransition {
  at: string;
  from: FlowPosition;
  to: FlowPosition;
  /** `start` enters the start node; `rule` matched a phrase; `decision` trusted the model. */
  tier: 'start' | 'rule' | 'decision' | 'fallback' | 'llm';
  intent?: string;
  confidence?: number;
  slots?: Record<string, string>;
  modelId?: string;
  disposition?: string;
  /** Why a fallback ran, or why an LLM resume point was refused. */
  reason?: 'other' | 'low-confidence' | 'unavailable' | 'ended' | 'invalid-resume';
  /** Line ids this call's variables could not fill, so they were not spoken. */
  skippedLines?: string[];
}
