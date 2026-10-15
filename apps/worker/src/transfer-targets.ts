import {
  effectiveHold,
  type AgentTransferRefusal,
  type HandoffTransferMeta,
  type RoutingMemberCandidate,
  type RoutingReleaseSnapshot,
  type RoutingTransferPolicy,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';
import { eligibleTiers, routeVariables } from '@winsendotai/ovo-plugin-router';
import type { CallMemory, SegmentHistoryEntry } from './call-memory.ts';
import type { ResolvedTarget, TransferControllerDeps } from './transfer-types.ts';

export interface TargetContext {
  policy: RoutingTransferPolicy;
  snapshot: Pick<RoutingReleaseSnapshot, 'pools' | 'language'>;
  memory: CallMemory;
  claims: TransferControllerDeps['claims'];
  now(): number;
}

type Resolution = ResolvedTarget | { refusal: AgentTransferRefusal };

/** A target is granted to a segment by its pool, its member or its agent; absent `from`: to all. */
export function granted(target: TransferTarget, from: SegmentHistoryEntry): boolean {
  if (!target.from) return from.role === 'agent';
  return target.from.some((source) => {
    if (source.kind === 'agent') return source.agentId === from.agentId;
    if (source.kind === 'pool') return source.poolId === from.poolId;
    return source.poolId === from.poolId && source.memberId === from.memberId;
  });
}

/**
 * Resolves a catalogue target into a handoff request (transfer design 7.2 step 3): an agent is
 * refused when it is the current release (`same_agent`) or, under `returnToPrevious: refuse`, one
 * the call already left (`ping_pong`); a pool's members are its eligible tiers for the call's
 * route context minus releases the call left (`ping_pong` if that empties them) minus the current
 * member and release (`same_agent`), and a member is claimed (the previous claim stays when the
 * pool is full: queued with the hold's `waitForCapacity`, else `pool_full`); a node re-routes.
 */
export async function resolveTransfer(
  context: TargetContext,
  target: TransferTarget,
  from: SegmentHistoryEntry,
  meta: HandoffTransferMeta,
): Promise<Resolution> {
  const { policy, memory } = context;
  const route = memory.route;
  const variables = routeVariables({
    ...(route?.language ? { language: route.language } : {}),
    values: route?.context ?? {},
  });
  const transfer = { ...meta, key: target.key };
  const left =
    policy.limits.returnToPrevious === 'refuse'
      ? memory.leftReleases(from.index)
      : new Set<string>();
  const destination = target.destination;
  if (destination.kind === 'node')
    return {
      request: { kind: 'node', reason: 'transfer', node: destination.node, variables, transfer },
      target,
      claimed: false,
    };
  if (destination.kind === 'agent') {
    const { agentId, release } = destination.agent;
    // A release snapshot pins every transfer agent (publish resolves `latest`).
    if (release.kind !== 'pinned') return { refusal: 'release_missing' };
    const releaseId = release.releaseId;
    if (releaseId === from.releaseId) return { refusal: 'same_agent' };
    if (left.has(releaseId)) return { refusal: 'ping_pong' };
    return {
      request: { kind: 'agent', reason: 'transfer', agentId, releaseId, variables, transfer },
      target,
      claimed: false,
    };
  }
  const poolId = destination.kind === 'pool' ? destination.poolId : from.poolId;
  const pool = poolId ? context.snapshot.pools[poolId] : undefined;
  if (!pool) return { refusal: 'no_eligible_member' };
  const poolTarget =
    destination.kind === 'pool'
      ? destination
      : {
          kind: 'pool' as const,
          poolId: pool.id,
          ...{ language: destination.language, skills: destination.skills },
        };
  const tiers = eligibleTiers({
    pool,
    target: poolTarget,
    context: {
      ...(route?.language ? { language: route.language } : {}),
      values: route?.context ?? {},
    },
    defaultLanguage: context.snapshot.language.default,
    now: context.now(),
  });
  if (!tiers.length) return { refusal: 'no_eligible_member' };
  const fresh = narrow(tiers, (candidate) => !left.has(candidate.releaseId));
  if (!fresh.length) return { refusal: 'ping_pong' };
  const others = narrow(
    fresh,
    (candidate) =>
      candidate.releaseId !== from.releaseId &&
      !(candidate.poolId === from.poolId && candidate.memberId === from.memberId),
  );
  if (!others.length) return { refusal: 'same_agent' };
  const claim = await context.claims.claim(others);
  const path = route?.path.slice(-32) ?? [];
  if (claim.kind === 'full') {
    if (!effectiveHold(policy, target.key).waitForCapacity) return { refusal: 'pool_full' };
    return {
      request: {
        kind: 'queue',
        reason: 'transfer',
        poolId: pool.id,
        tiers: others,
        variables,
        transfer,
      },
      target,
      claimed: false,
    };
  }
  const { candidate } = claim;
  return {
    request: {
      ...{ kind: 'agent', reason: 'transfer', agentId: candidate.agentId },
      ...{ releaseId: candidate.releaseId, variables, transfer },
      route: {
        path,
        poolId: candidate.poolId,
        memberId: candidate.memberId,
        ...(claim.kind === 'claimed' ? { claimId: claim.claimId } : {}),
      },
    },
    target,
    claimed: claim.kind === 'claimed',
  };
}

function narrow(
  tiers: readonly RoutingMemberCandidate[][],
  keep: (candidate: RoutingMemberCandidate) => boolean,
): RoutingMemberCandidate[][] {
  return tiers.map((tier) => tier.filter(keep)).filter((tier) => tier.length);
}
