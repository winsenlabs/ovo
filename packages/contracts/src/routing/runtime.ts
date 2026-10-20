import { z } from 'zod';
import { RouteAgentId, RouteContextKey, RouteUuid, RoutingKey } from './ids.ts';
import type { ExternalEngine } from './engines.ts';
import { TRANSFER_LIMITS } from './transfer.ts';

export interface RouteContext {
  /** Base code, in language.allowed. */
  language?: string;
  /** RouteContextKey → RoutingKey value. */
  values: Record<string, string>;
}

export const RoutingMemberCandidateSchema = z
  .object({
    poolId: RouteUuid,
    memberId: RoutingKey,
    agentId: RouteAgentId,
    releaseId: RouteUuid,
    capacity: z.number().int().min(1).max(10_000).optional(),
  })
  .strict();

/** Only `ovo_route_*` names; merged over the call's own variables for the target. */
const HandoffVariables = z
  .record(z.string().regex(/^ovo_route_[a-z][a-z0-9_]{0,39}$/), z.string().max(200))
  .default({});
const HandoffRoute = z
  .object({
    path: z.array(RoutingKey).max(32),
    poolId: RouteUuid.optional(),
    memberId: RoutingKey.optional(),
    claimId: RouteUuid.optional(),
  })
  .strict();
/** R2: what the requester knows that the host cannot see. Free text is untrusted, never logged or evented. */
export const HandoffTransferMeta = z
  .object({
    key: RoutingKey.optional(),
    source: z.enum(['router', 'llm', 'flow', 'fallback']),
    reason: z.string().trim().max(TRANSFER_LIMITS.reasonChars).optional(),
    summary: z.string().trim().max(TRANSFER_LIMITS.summaryChars).optional(),
  })
  .strict();
export type HandoffTransferMeta = z.infer<typeof HandoffTransferMeta>;

/** One agent release. R1's router sends `reason: 'route'`; R2's transfers send `transfer`. */
const AgentHandoff = z
  .object({
    kind: z.literal('agent'),
    reason: z.enum(['route', 'transfer']),
    agentId: RouteAgentId,
    /** Must be in the routing snapshot's releaseIds. */
    releaseId: RouteUuid,
    variables: HandoffVariables,
    route: HandoffRoute.optional(),
    transfer: HandoffTransferMeta.optional(),
  })
  .strict();
/** R2: a pool whose eligible members are all full; the host claims (and, with waitForCapacity, retries on hold). */
const QueueHandoff = z
  .object({
    kind: z.literal('queue'),
    reason: z.enum(['route', 'transfer']),
    poolId: RouteUuid,
    tiers: z.array(z.array(RoutingMemberCandidateSchema).min(1).max(100)).min(1).max(101),
    variables: HandoffVariables,
    route: HandoffRoute.optional(),
    transfer: HandoffTransferMeta.optional(),
  })
  .strict();
/** R2: re-route through the tree from `node`. */
const NodeHandoff = z
  .object({
    kind: z.literal('node'),
    reason: z.literal('transfer'),
    node: RoutingKey,
    variables: HandoffVariables,
    transfer: HandoffTransferMeta,
  })
  .strict();

/** R3: a person, through the human queue bound as `queueId` in the release (`humanQueues`). */
const HumanHandoff = z
  .object({
    kind: z.literal('human'),
    reason: z.enum(['route', 'transfer']),
    queueId: RoutingKey,
    variables: HandoffVariables,
    route: HandoffRoute.optional(),
    transfer: HandoffTransferMeta.optional(),
  })
  .strict();

/**
 * Hand the call to another agent release (or back to the router) on the same carrier leg and media
 * link, or (R3) to a person.
 */
export const SegmentHandoffRequest = z.discriminatedUnion('kind', [
  AgentHandoff,
  QueueHandoff,
  NodeHandoff,
  HumanHandoff,
]);
export type SegmentHandoffRequest = z.infer<typeof SegmentHandoffRequest>;

export type HandoffPrepareFailure =
  | 'release_not_allowed'
  | 'release_missing'
  | 'compose_failed'
  | 'timeout'
  | 'call_ended'
  | 'busy'
  /** R2: `prepare()` given a kind other than `agent`. */
  | 'unsupported'
  /** R3 human queues. */
  | 'queue_unknown'
  | 'queue_closed'
  | 'queue_unavailable'
  | 'queue_full'
  | 'no_operators'
  | 'webhook_rejected'
  | 'webhook_failed'
  | 'ticket_expired'
  | 'carrier_refused';
export type HandoffPrepareResult =
  { ok: true; handoffId: string } | { ok: false; reason: HandoffPrepareFailure };
export type HandoffBeginFailure =
  HandoffPrepareFailure | 'pool_full' | 'segments_exhausted' | 'time_exhausted';
export type HandoffBeginResult =
  | { ok: true; handoffId: string; state: 'preparing' | 'queued' | 'ready' }
  | { ok: false; reason: HandoffBeginFailure };

/** Capability `ovo.segment-handoff` (session). Provided by the worker host; R2's transfer tool uses it too. */
export interface SegmentHandoffPort {
  /** Loads and composes the target graph (not started) and pre-connects its STT. Bounded by the host. */
  prepare(request: SegmentHandoffRequest, signal: AbortSignal): Promise<HandoffPrepareResult>;
  /** The current segment will end as soon as its behaviour completes; the media link is kept. */
  commit(handoffId: string): void;
  /** Disposes a prepared, uncommitted graph and releases its member claim. Idempotent. */
  abandon(handoffId: string): Promise<void>;
  /**
   * R2, present only with OVO_ROUTING_TRANSFER_ENABLED. Validates synchronously-checkable things,
   * claims (a `queue` request tries once; with the effective hold's waitForCapacity a full pool
   * answers `queued`, otherwise `pool_full`), then composes the target in the background and
   * returns. Commit or abandon it like a prepared handoff. After commit every failure is the host's:
   * the hold, then the hold's onTimeout chain. Never throws for a refusal.
   */
  begin?(request: SegmentHandoffRequest, signal: AbortSignal): Promise<HandoffBeginResult>;
}

export interface RoutingMemberCandidate {
  poolId: string;
  memberId: string;
  agentId: string;
  releaseId: string;
  capacity?: number;
}
export type MemberClaim =
  | { kind: 'claimed'; claimId: string; candidate: RoutingMemberCandidate }
  /** Fail-open: claim storage is down, so capacity is not enforced for this call. */
  | { kind: 'unclaimed'; candidate: RoutingMemberCandidate; reason: 'claims_unavailable' }
  | { kind: 'full' };

/** What an external decision webhook answers (`ovo.route-decision/1`). */
export const ExternalDecisionResponse = z.looseObject({
  branch: RoutingKey.nullable(),
  confidence: z.number().min(0).max(1).default(1),
  slots: z.record(RouteContextKey, RoutingKey).default({}),
});
export type ExternalDecisionResponse = z.infer<typeof ExternalDecisionResponse>;

export type RoutingEngineErrorKind = 'timeout' | 'transport' | 'invalid' | 'disabled';
export class RoutingEngineError extends Error {
  readonly kind: RoutingEngineErrorKind;
  constructor(kind: RoutingEngineErrorKind, message: string) {
    super(message);
    this.name = 'RoutingEngineError';
    this.kind = kind;
  }
}

/** Capability `ovo.routing` (session). Provided by the worker host to the router behaviour only. */
export interface RoutingHost {
  readonly call: {
    callId: string;
    workspaceId: string;
    routingPointId: string;
    routingReleaseId: string;
    from?: string;
    to?: string;
    variables: Readonly<Record<string, unknown>>;
  };
  /** Signed webhook, executed by the host (secret and egress never reach the plugin). Throws RoutingEngineError. */
  external(
    input: {
      node: string;
      engine: ExternalEngine;
      turn?: { text?: string; digits?: string };
      context: RouteContext;
      branches: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<ExternalDecisionResponse>;
  /** Tiers in priority order; the host picks the least-loaded member with room in the first tier that has one. */
  claim(
    tiers: readonly (readonly RoutingMemberCandidate[])[],
    signal: AbortSignal,
  ): Promise<MemberClaim>;
  /** Epoch ms (fake clock in tests). */
  now(): number;
}
