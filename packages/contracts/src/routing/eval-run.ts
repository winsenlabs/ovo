import { z } from 'zod';
import { RouteUuid } from './ids.ts';
import { ROUTING_EVAL_LIMITS, RoutingEvalCase } from './eval.ts';
import { RoutingScorecard } from './scorecard.ts';
import { SimulationAssume } from './simulate.ts';

/** Server-run corpus scoring against a routing release, persisted (`/v1/routing/eval-runs`). */
export const EvalRunRequest = z
  .object({
    routingReleaseId: RouteUuid,
    name: z.string().trim().min(1).max(120),
    cases: z.array(RoutingEvalCase).min(1).max(ROUTING_EVAL_LIMITS.cases),
    assume: SimulationAssume.default({}),
  })
  .strict();
export type EvalRunRequest = z.infer<typeof EvalRunRequest>;

const Rate = z.number().min(0).max(1).nullable();
export const RoutingEvalRunSummary = z.object({
  id: RouteUuid,
  name: z.string().min(1).max(120),
  routingReleaseId: RouteUuid,
  routingPointId: RouteUuid,
  releaseVersion: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  createdBy: z.string().max(200),
  engineMode: z.literal('recorded'),
  caseCount: z.number().int().min(1).max(ROUTING_EVAL_LIMITS.cases),
  headline: z.object({
    passed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    accuracy: Rate,
    fallbackRate: Rate,
    clarifyRate: Rate,
  }),
});
export type RoutingEvalRunSummary = z.infer<typeof RoutingEvalRunSummary>;

export const RoutingEvalRun = RoutingEvalRunSummary.extend({
  corpusDigest: z.string().regex(/^[0-9a-f]{64}$/),
  scorecard: RoutingScorecard,
});
export type RoutingEvalRun = z.infer<typeof RoutingEvalRun>;
