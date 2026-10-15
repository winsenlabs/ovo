import { z } from 'zod';
import { RouteAgentRef, RouteContextKey, RouteLines, RouteUuid, RoutingKey } from './ids.ts';
import { RoutingEngine } from './engines.ts';

const MatchValue = z.union([
  /** e.g. `{ context: 'product' }`: the value the route context holds. */
  z.object({ context: RouteContextKey }).strict(),
  z.object({ values: z.array(RoutingKey).min(1).max(10) }).strict(),
]);

const CallbackTarget = {
  inMinutes: z.number().int().min(5).max(10_080).default(120),
  line: RouteLines,
  agent: RouteAgentRef.optional(),
};

/** A pool target: claim a member of the pool. Also a transfer destination (R2). */
export const RoutingPoolTarget = z
  .object({
    kind: z.literal('pool'),
    poolId: RouteUuid,
    /** `caller`: members must speak the route context's language (else pool languageFallback). */
    language: z.enum(['caller', 'any']).default('caller'),
    /** member.products must include it. */
    products: MatchValue.optional(),
    /** member.skills must include all. */
    skills: z.array(RoutingKey).max(10).default([]),
  })
  .strict();
export type RoutingPoolTarget = z.infer<typeof RoutingPoolTarget>;
/** One agent, directly. Also a transfer destination (R2). */
export const RoutingAgentTarget = z
  .object({ kind: z.literal('agent'), agent: RouteAgentRef })
  .strict();
export type RoutingAgentTarget = z.infer<typeof RoutingAgentTarget>;

export const RoutingTarget = z.discriminatedUnion('kind', [
  RoutingPoolTarget,
  RoutingAgentTarget,
  z
    .object({ kind: z.literal('end'), line: RouteLines, disposition: RoutingKey.optional() })
    .strict(),
  z.object({ kind: z.literal('callback'), ...CallbackTarget }).strict(),
  /** R3. In R1: a warning at publish, skipped at run time (`route.fallback` result `skipped`). */
  z.object({ kind: z.literal('human'), queueId: RoutingKey }).strict(),
]);
export type RoutingTarget = z.infer<typeof RoutingTarget>;

export const RoutingBranch = z
  .object({
    key: RoutingKey,
    /** What the decision model and the LLM read. Never the target. */
    description: z.string().trim().min(1).max(2_000),
    /** A node id. */
    next: RoutingKey.optional(),
    target: RoutingTarget.optional(),
  })
  .strict()
  .refine(
    (b) => (b.next === undefined) !== (b.target === undefined),
    'A branch has exactly one of next or target',
  );
export type RoutingBranch = z.infer<typeof RoutingBranch>;

export const FallbackStep = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('reask'),
      times: z.number().int().min(1).max(3).default(1),
      line: RouteLines.optional(),
    })
    .strict(),
  /** Absent target = the release's defaultTarget. */
  z.object({ kind: z.literal('default'), target: RoutingTarget.optional() }).strict(),
  z.object({ kind: z.literal('human'), queueId: RoutingKey }).strict(),
  z.object({ kind: z.literal('callback'), ...CallbackTarget }).strict(),
  z.object({ kind: z.literal('end'), line: RouteLines }).strict(),
]);
export type FallbackStep = z.infer<typeof FallbackStep>;

export const RoutingNode = z
  .object({
    id: RoutingKey,
    /** The chosen branch key is stored as route context[sets] (`language` is special: must be an allowed language). */
    sets: RouteContextKey.optional(),
    /** Spoken when the node needs the caller and on `reask` without its own line. */
    ask: RouteLines.optional(),
    engines: z.array(RoutingEngine).min(1).max(4),
    branches: z.array(RoutingBranch).min(1).max(32),
    fallback: z.array(FallbackStep).min(1).max(6),
    /** Evaluate this node on the same caller turn that chose it (one utterance can answer several nodes). */
    reuseTurn: z.boolean().default(true),
  })
  .strict();
export type RoutingNode = z.infer<typeof RoutingNode>;

export type RoutingPath = (string | number)[];

/**
 * Every target-shaped object in a tree with its path: branch targets, `default` step targets, and
 * the `human`, `callback` and `end` steps (which have a target's shape). Shared by the structural
 * checks, the release snapshot refine, publish resolution and the router.
 */
export function routingNodeTargets(
  nodes: readonly RoutingNode[],
): { path: RoutingPath; target: RoutingTarget }[] {
  const found: { path: RoutingPath; target: RoutingTarget }[] = [];
  nodes.forEach((node, n) => {
    node.branches.forEach((branch, b) => {
      if (branch.target)
        found.push({ path: ['nodes', n, 'branches', b, 'target'], target: branch.target });
    });
    node.fallback.forEach((step, s) => {
      if (step.kind === 'default') {
        if (step.target)
          found.push({ path: ['nodes', n, 'fallback', s, 'target'], target: step.target });
      } else if (step.kind !== 'reask')
        found.push({ path: ['nodes', n, 'fallback', s], target: step });
    });
  });
  return found;
}
