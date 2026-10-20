import { z } from 'zod';
import { RouteLanguage, RoutingKey } from '@winsendotai/ovo-contracts';
import { SimulatedAnswer, SimulationCall, SimulationFaults, SimulationTurn } from './simulate.ts';

/** The routing corpus and its scorecard (R4 design 3.3); `wire/index.ts` switches these to the contracts. */
export const ROUTING_EVAL_SCHEMA = 'ovo.routing-eval/1';
export const ROUTING_SCORECARD_SCHEMA = 'ovo.routing-scorecard/1';
export const ROUTING_EVAL_LIMITS = Object.freeze({
  cases: 500,
  tags: 10,
  bodyBytes: 1024 * 1024,
  failures: 50,
});

export const RoutingEvalExpect = z
  .object({
    status: z.enum(['agent', 'queue', 'human', 'end', 'callback']).optional(),
    /** Exact node path. */
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
    /** The deepest fallback step expected; `none` = a clean route with no fallback. */
    fallback: z
      .enum(['none', 'default', 'human', 'callback', 'end', 'limit', 'release_default'])
      .optional(),
    /** Whether the router should ask a clarifying question (a reask) at least once. */
    clarify: z.boolean().optional(),
  })
  .strict()
  .refine((expect) => Object.keys(expect).length > 0, 'A case expects something');

export const RoutingEvalCase = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/),
    description: z.string().max(300).optional(),
    tags: z.array(RoutingKey).max(10).default([]),
    call: SimulationCall,
    turns: z.array(SimulationTurn).max(20).default([]),
    /** Recorded or authored engine answers. */
    answers: z.array(SimulatedAnswer).max(100).default([]),
    faults: SimulationFaults,
    expect: RoutingEvalExpect,
  })
  .strict();
export type RoutingEvalCase = z.infer<typeof RoutingEvalCase>;

export interface Rate {
  correct: number;
  total: number;
  rate: number | null;
}
type EngineName = 'rules' | 'decision' | 'llm' | 'external' | 'context';
interface EngineCounts {
  attempts: number;
  matched: number;
  no_match: number;
  low_confidence: number;
  timeout: number;
  error: number;
  disabled: number;
}
export interface RoutingScorecard {
  schema: typeof ROUTING_SCORECARD_SCHEMA;
  /** Live: at least one engine ran for real. */
  engineMode: 'recorded' | 'live';
  corpus: { name: string; digest: string; cases: number };
  routing: { pointId: string | null; routingReleaseId: string | null; digest: string };
  totals: { cases: number; passed: number; failed: number };
  /** Total = the cases that assert the field. */
  accuracy: {
    overall: Rate;
    status: Rate;
    path: Rate;
    node: Rate;
    branch: Rate;
    pool: Rate;
    member: Rate;
    agent: Rate;
    queue: Rate;
    language: Rate;
  };
  fallbackRate: Rate & {
    byStep: Partial<
      Record<'default' | 'human' | 'callback' | 'end' | 'limit' | 'release_default', number>
    >;
  };
  /** Cases with at least one reask taken. */
  clarifyRate: Rate;
  /** Cases that ended in an end or undecided. */
  endRate: Rate;
  perEngine: Record<EngineName, EngineCounts>;
  /** Per deciding engine: expected branch (rows) vs the branch it chose (columns); `none` = nothing matched. */
  confusion: Record<
    string,
    { labels: string[]; matrix: number[][]; correct: number; total: number }
  >;
  calibration: {
    engine: 'decision' | 'llm' | 'external';
    bucket: '0-0.5' | '0.5-0.7' | '0.7-0.9' | '0.9-1';
    n: number;
    correct: number;
  }[];
  perNode: { node: string; cases: number; decided: number; correct: number; fallbacks: number }[];
  byTag: Record<string, { cases: number; passed: number }>;
  /** At most 50: ids and field diffs only, never an utterance. */
  failures: {
    id: string;
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    diff: string[];
  }[];
  ms: { total: number; p50: number; p95: number };
}
