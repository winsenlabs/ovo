import { z } from 'zod';
import { ROUTING_EVAL_LIMITS, ROUTING_SCORECARD_SCHEMA } from './eval.ts';

/** The scorer's report (design 3.3). Failures name case ids and field diffs, never utterance text. */
const Count = z.number().int().nonnegative();
export const EvalRate = z.object({
  correct: Count,
  total: Count,
  /** Null while `total` is 0. */
  rate: z.number().min(0).max(1).nullable(),
});
export type EvalRate = z.infer<typeof EvalRate>;

const EngineTally = z.object({
  attempts: Count,
  matched: Count,
  no_match: Count,
  low_confidence: Count,
  timeout: Count,
  error: Count,
  disabled: Count,
});
export type EngineTally = z.infer<typeof EngineTally>;

const FALLBACK_STEPS = ['default', 'human', 'callback', 'end', 'limit', 'release_default'] as const;
export const CALIBRATION_BUCKETS = ['0-0.5', '0.5-0.7', '0.7-0.9', '0.9-1'] as const;

export const RoutingScorecard = z.object({
  schema: z.literal(ROUTING_SCORECARD_SCHEMA),
  /** `live`: at least one engine ran for real. */
  engineMode: z.enum(['recorded', 'live']),
  corpus: z.object({ name: z.string().max(200), digest: z.string().max(64), cases: Count }),
  routing: z.object({
    pointId: z.string().max(200).nullable(),
    routingReleaseId: z.string().max(200).nullable(),
    digest: z.string().max(64),
  }),
  totals: z.object({ cases: Count, passed: Count, failed: Count }),
  /** `total` = the cases that assert the field. */
  accuracy: z.object({
    overall: EvalRate,
    status: EvalRate,
    path: EvalRate,
    node: EvalRate,
    branch: EvalRate,
    pool: EvalRate,
    member: EvalRate,
    agent: EvalRate,
    queue: EvalRate,
    language: EvalRate,
  }),
  fallbackRate: EvalRate.extend({
    byStep: z.partialRecord(z.enum(FALLBACK_STEPS), Count),
  }),
  /** Cases with at least one reask taken. */
  clarifyRate: EvalRate,
  /** Cases that ended in an end or undecided. */
  endRate: EvalRate,
  perEngine: z.object({
    rules: EngineTally,
    decision: EngineTally,
    llm: EngineTally,
    external: EngineTally,
    context: EngineTally,
  }),
  /** Per deciding engine: expected branch (rows) against the branch it chose (columns); `none` = nothing matched. */
  confusion: z.record(
    z.string(),
    z.object({
      labels: z.array(z.string()),
      matrix: z.array(z.array(Count)),
      correct: Count,
      total: Count,
    }),
  ),
  calibration: z.array(
    z.object({
      engine: z.enum(['decision', 'llm', 'external']),
      bucket: z.enum(CALIBRATION_BUCKETS),
      n: Count,
      correct: Count,
    }),
  ),
  perNode: z.array(
    z.object({ node: z.string(), cases: Count, decided: Count, correct: Count, fallbacks: Count }),
  ),
  byTag: z.record(z.string(), z.object({ cases: Count, passed: Count })),
  failures: z
    .array(
      z.object({
        id: z.string(),
        expected: z.record(z.string(), z.unknown()),
        actual: z.record(z.string(), z.unknown()),
        diff: z.array(z.string()),
      }),
    )
    .max(ROUTING_EVAL_LIMITS.failures),
  ms: z.object({
    total: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
  }),
});
export type RoutingScorecard = z.infer<typeof RoutingScorecard>;
