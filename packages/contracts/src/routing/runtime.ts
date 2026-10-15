import { z } from 'zod';
import { RouteAgentId, RouteContextKey, RouteUuid, RoutingKey } from './ids.ts';
import type { ExternalEngine } from './engines.ts';

export interface RouteContext {
  /** Base code, in language.allowed. */
  language?: string;
  /** RouteContextKey → RoutingKey value. */
  values: Record<string, string>;
}

/**
 * Hand the call to another agent release on the same carrier leg and media link. R1's router is
 * the only caller (`reason: 'route'`); R2 adds `transfer` (and R3 `kind: 'human'`) additively.
 */
export const SegmentHandoffRequest = z
  .object({
    kind: z.literal('agent'),
    reason: z.literal('route'),
    agentId: RouteAgentId,
    /** Must be in the routing snapshot's releaseIds. */
    releaseId: RouteUuid,
    /** Only `ovo_route_*` names; merged over the call's own variables for the target. */
    variables: z
      .record(z.string().regex(/^ovo_route_[a-z][a-z0-9_]{0,39}$/), z.string().max(200))
      .default({}),
    route: z
      .object({
        path: z.array(RoutingKey).max(32),
        poolId: RouteUuid.optional(),
        memberId: RoutingKey.optional(),
        claimId: RouteUuid.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SegmentHandoffRequest = z.infer<typeof SegmentHandoffRequest>;

export type HandoffPrepareFailure =
  'release_not_allowed' | 'release_missing' | 'compose_failed' | 'timeout' | 'call_ended' | 'busy';
export type HandoffPrepareResult =
  { ok: true; handoffId: string } | { ok: false; reason: HandoffPrepareFailure };

/** Capability `ovo.segment-handoff` (session). Provided by the worker host; R2's transfer tool uses it too. */
export interface SegmentHandoffPort {
  /** Loads and composes the target graph (not started) and pre-connects its STT. Bounded by the host. */
  prepare(request: SegmentHandoffRequest, signal: AbortSignal): Promise<HandoffPrepareResult>;
  /** The current segment will end as soon as its behaviour completes; the media link is kept. */
  commit(handoffId: string): void;
  /** Disposes a prepared, uncommitted graph and releases its member claim. Idempotent. */
  abandon(handoffId: string): Promise<void>;
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
