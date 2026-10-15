import type { MemberClaim, RoutingHost, RoutingMemberCandidate } from '@winsendotai/ovo-contracts';
import { callExternalRouteEngine, type ExternalRouteOptions } from './routing-external.ts';

/** Seconds a member claim outlives the call's own limit, so a crashed worker's claim lapses. */
export const ROUTING_CLAIM_GRACE_SECONDS = 120;

/** The member claims of `operations.routing.claims` the worker uses (routing design 5.2). */
export interface RoutingClaims {
  claim(input: {
    callId: string;
    routingReleaseId: string;
    ttlSeconds: number;
    tiers: readonly (readonly RoutingMemberCandidate[])[];
  }): Promise<MemberClaim>;
  release(callId: string): Promise<number>;
}

/**
 * The `RoutingHost` the router behaviour reads (`Cap.routing`): the call it routes, the external
 * decision webhook executed here (its secret and egress never reach the plugin), and member
 * claims. Capacity is soft: claim storage that fails answers `unclaimed` with the first eligible
 * member, so routing goes on (fail-open, routing design 8.2).
 */
export function createRoutingHost(input: {
  call: RoutingHost['call'];
  /** The claim key: the job id, as admission and finalisation use. */
  jobId: string;
  /** The router policy's call limit; a claim lasts as long, plus the grace. */
  maxCallSeconds: number;
  claims?: Pick<RoutingClaims, 'claim'>;
  external: Omit<ExternalRouteOptions, 'call'>;
  audit?: (type: string, payload: Record<string, unknown>) => void;
  now?: () => number;
}): RoutingHost {
  const external = { ...input.external, call: input.call };
  return {
    call: input.call,
    external: (request, signal) => callExternalRouteEngine(external, request, signal),
    async claim(tiers) {
      const first = tiers.find((tier) => tier.length)?.[0];
      if (!first) return { kind: 'full' };
      try {
        if (!input.claims) throw new Error('member claims are not composed');
        return await input.claims.claim({
          callId: input.jobId,
          routingReleaseId: input.call.routingReleaseId,
          ttlSeconds: input.maxCallSeconds + ROUTING_CLAIM_GRACE_SECONDS,
          tiers,
        });
      } catch {
        input.audit?.('route.claims.unavailable', { poolId: first.poolId });
        return { kind: 'unclaimed', candidate: first, reason: 'claims_unavailable' };
      }
    },
    now: input.now ?? Date.now,
  };
}
