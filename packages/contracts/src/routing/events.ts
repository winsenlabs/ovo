import { z } from 'zod';

/**
 * Payloads of the four `route.*` session events. Like the other session events they are loose (a
 * newer emitter's extra field is kept) and carry branch keys, engine names, confidences and ids:
 * never caller words, never phone numbers.
 */
const Name = z.string().trim().min(1).max(200);
const Turn = z.number().int().nonnegative();

export const ROUTE_NODE_ENGINES = ['context', 'rules', 'decision', 'llm', 'external'] as const;
export const RouteNodePayload = z.looseObject({
  /** Router turn (0 = opening). */
  turn: Turn,
  node: Name,
  engine: z.enum(ROUTE_NODE_ENGINES),
  outcome: z.enum(['matched', 'no_match', 'low_confidence', 'timeout', 'error', 'disabled']),
  branch: Name.optional(),
  confidence: z.number().min(0).max(1).optional(),
  ms: z.number().nonnegative().optional(),
  modelId: z.string().max(200).optional(),
  /** 'llm_text_reply', 'unknown_branch', 'http_503'... */
  reason: z.string().max(200).optional(),
});
export type RouteNodePayload = z.infer<typeof RouteNodePayload>;

export const RouteFallbackPayload = z.looseObject({
  turn: Turn,
  node: Name,
  /** `target`: a branch target failed before any fallback step ran (R2; its reason is kept). */
  step: z.enum([
    'reask',
    'default',
    'human',
    'callback',
    'end',
    'limit',
    'release_default',
    'target',
  ]),
  result: z.enum(['taken', 'skipped', 'failed']),
  attempt: z.number().int().min(1),
  /** 'pool_full', 'no_eligible_member', 'human_queue_unavailable', 'compose_failed'... */
  reason: z.string().max(200).optional(),
});
export type RouteFallbackPayload = z.infer<typeof RouteFallbackPayload>;

export const ROUTE_DECISION_TARGETS = ['agent', 'end', 'callback', 'human'] as const;
export const RouteDecisionPayload = z.looseObject({
  routingPointId: Name,
  routingReleaseId: Name,
  path: z.array(Name).max(32),
  target: z.enum(ROUTE_DECISION_TARGETS),
  agentId: Name.optional(),
  releaseId: Name.optional(),
  poolId: Name.optional(),
  memberId: Name.optional(),
  language: z.string().max(3).optional(),
  context: z
    .record(z.string().max(40), z.string().max(80))
    .refine((context) => Object.keys(context).length <= 16, 'At most 16 context keys')
    .optional(),
  turns: Turn,
  routeMs: z.number().nonnegative(),
  /** 'router_compose_failed', 'routing_disabled'... */
  degraded: z.string().max(200).optional(),
});
export type RouteDecisionPayload = z.infer<typeof RouteDecisionPayload>;

export const RouteSegmentPayload = z.looseObject({
  index: Turn,
  role: z.enum(['router', 'agent', 'human']),
  /** A human segment: `queue:<key>`. */
  agentId: Name,
  /** A human segment: the queue id. */
  releaseId: Name,
  /**
   * R2: `transfer` (an agent or a router transfer), `return` (a failed transfer back to the agent
   * that asked), `reroute` (a router segment resuming at a node; role `router`).
   */
  reason: z.enum(['start', 'route', 'degraded', 'fallback', 'transfer', 'return', 'reroute']),
  poolId: Name.optional(),
  memberId: Name.optional(),
  prepareMs: z.number().nonnegative().optional(),
  gapMs: z.number().nonnegative().optional(),
  /** R2: the transfer (1-based per call) this segment answers. */
  transfer: z.number().int().min(1).optional(),
  language: z.string().max(12).optional(),
  /** R2: the segment that handed over. */
  fromIndex: Turn.optional(),
  /** R3, role `human`. */
  queueId: Name.optional(),
  ticketId: Name.optional(),
  kind: z.enum(['external', 'managed']).optional(),
});
export type RouteSegmentPayload = z.infer<typeof RouteSegmentPayload>;

/** `CallOutcomeSummary.route`: the folded `route.decision` and `route.segment` events of a call. */
export interface CallOutcomeRoute {
  routingPointId: string;
  routingReleaseId: string;
  path: string[];
  target: (typeof ROUTE_DECISION_TARGETS)[number];
  agentId: string | null;
  releaseId: string | null;
  poolId: string | null;
  memberId: string | null;
  language: string | null;
  degraded: string | null;
  segments: number;
  /**
   * R4, folded from `route.decision` (`turns`, `routeMs`) and `route.fallback` (`fallbacks`: a taken
   * or failed step that is not `reask`; `reasks`: a taken `reask`). Rows from before R4 omit them.
   */
  turns?: number | null;
  routeMs?: number | null;
  fallbacks?: number;
  reasks?: number;
}
