import { z } from 'zod';
import { RouteLanguage, RoutingKey } from './ids.ts';
import { SimulatedAnswer, SimulationCall, SimulationFaults, SimulationTurn } from './simulate.ts';

/**
 * Wave 18 (R4) routing eval corpus: a caller (utterances, keypad digits, caller id, a clock) and
 * what the router should do with it. The scorer (`plugin-router`) runs each case through the
 * simulator, so scoring and simulation cannot disagree. A corpus scores the tree, the rules and
 * the pool logic; engine answers are authored or recorded, so it does not score model quality.
 */
export const ROUTING_EVAL_SCHEMA = 'ovo.routing-eval/1';
export const ROUTING_SCORECARD_SCHEMA = 'ovo.routing-scorecard/1';
export const ROUTING_EVAL_LIMITS = Object.freeze({
  cases: 500,
  tags: 10,
  bodyBytes: 1024 * 1024,
  failures: 50,
});

export const EVAL_FALLBACK_STEPS = [
  'none',
  'default',
  'human',
  'callback',
  'end',
  'limit',
  'release_default',
] as const;

export const RoutingEvalExpect = z
  .object({
    status: z.enum(['agent', 'queue', 'human', 'end', 'callback']).optional(),
    /** The exact node path. */
    path: z.array(RoutingKey).max(32).optional(),
    /** The node the route ended at. */
    node: RoutingKey.optional(),
    /** Node id -> the branch that should be chosen there (feeds the per-engine confusion matrix). */
    branches: z.record(RoutingKey, RoutingKey).optional(),
    /** Pool name or id. */
    pool: z.string().max(120).optional(),
    member: RoutingKey.optional(),
    agentId: z.string().max(200).optional(),
    /** Human queue key. */
    queue: RoutingKey.optional(),
    language: RouteLanguage.optional(),
    /** The deepest non-reask fallback step expected; `none` = a clean route with no fallback. */
    fallback: z.enum(EVAL_FALLBACK_STEPS).optional(),
    /** Whether the router should ask a clarifying question (a reask) at least once. */
    clarify: z.boolean().optional(),
  })
  .strict()
  .refine((expect) => Object.keys(expect).length > 0, 'A case expects something');
export type RoutingEvalExpect = z.infer<typeof RoutingEvalExpect>;

export const RoutingEvalCase = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/),
    description: z.string().max(300).optional(),
    tags: z.array(RoutingKey).max(ROUTING_EVAL_LIMITS.tags).default([]),
    call: SimulationCall,
    turns: z.array(SimulationTurn).max(20).default([]),
    /** Recorded or authored engine answers. */
    answers: z.array(SimulatedAnswer).max(100).default([]),
    faults: SimulationFaults,
    expect: RoutingEvalExpect,
  })
  .strict();
export type RoutingEvalCase = z.infer<typeof RoutingEvalCase>;
