import { randomUUID } from 'node:crypto';
import {
  effectiveHold,
  TRANSFER_LIMITS,
  type HandoffBeginFailure,
  type MemberClaim,
  type RouterEntry,
  type RoutingMemberCandidate,
  type SegmentHandoffRequest,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';
import type { SegmentHistoryEntry } from './call-memory.ts';
import type { AttemptTarget, SegmentReason } from './transfer-attempt.ts';
import { beginHuman } from './transfer-human.ts';
import { capturedFor } from './transfer-handover.ts';
import {
  MAX_SEGMENT_INDEX,
  type ConnectHost,
  type HoldSource,
  type TransferRun,
} from './transfer-types.ts';

export interface BeginOptions {
  /** The catalogue target an agent's port resolved the request from. */
  target?: TransferTarget;
  /** The member claim the port took for it (the call's previous claim gave way). */
  claimed?: boolean;
}

interface BeginHost extends ConnectHost {
  transfers: number;
  readonly segments: number;
  readonly composedSegments: number;
}

type Begun =
  | { ok: true; run: TransferRun; state: 'preparing' | 'queued' | 'ready' }
  | { ok: false; reason: HandoffBeginFailure | 'human_queue_unavailable' };

/**
 * Validates a handoff request and starts it (transfer design 4.3, 7.2 step 3): the limits the host
 * can check at once, the release the snapshot allows, then for a `queue` one claim attempt (a full
 * pool is `queued` when the effective hold waits for capacity, else `pool_full`), and the target's
 * composition in the background. Nothing is composed for a refused request.
 */
export async function beginRun(
  host: BeginHost,
  request: SegmentHandoffRequest,
  from: SegmentHistoryEntry,
  options: BeginOptions,
): Promise<Begun> {
  const { deps, clock } = host;
  if (
    host.segments >= TRANSFER_LIMITS.segmentsPerCall ||
    host.composedSegments >= MAX_SEGMENT_INDEX
  )
    return { ok: false, reason: 'segments_exhausted' };
  if (deps.callEndsAt - clock.now() < 1_000) return { ok: false, reason: 'time_exhausted' };
  const key = options.target?.key ?? request.transfer?.key;
  const target = options.target ?? deps.policy?.targets.find((item) => item.key === key);
  const transfer =
    request.reason !== 'transfer'
      ? undefined
      : from.role === 'router' && from.transfer !== undefined
        ? from.transfer
        : host.transfers + 1;
  const run: TransferRun = {
    id: randomUUID(),
    request,
    ...(transfer !== undefined ? { transfer } : {}),
    ...(request.transfer ? { meta: request.transfer } : {}),
    ...(target ? { target } : {}),
    from,
    committed: false,
    begunAt: clock.now(),
    hold: { policy: effectiveHold(deps.policy, key), source: holdSource(deps.policy, target) },
    claimed: options.claimed ?? Boolean(request.kind !== 'node' && request.route?.claimId),
  };
  const reason: SegmentReason = request.reason === 'route' ? 'route' : 'transfer';
  if (request.kind === 'human') {
    const refused = await beginHuman(host, run, request, target);
    if (refused) return { ok: false, reason: refused };
  } else if (request.kind === 'agent') {
    if (!deps.allowed.has(request.releaseId)) return { ok: false, reason: 'release_not_allowed' };
    run.attempt = host.attempt(run, agentTarget(host, request, reason));
  } else if (request.kind === 'queue') {
    const tiers = request.tiers
      .map((tier) => tier.filter((candidate) => deps.allowed.has(candidate.releaseId)))
      .filter((tier) => tier.length);
    if (!tiers.length) return { ok: false, reason: 'release_not_allowed' };
    const claim = await deps.claims.claim(tiers);
    if (claim.kind === 'full') {
      if (!run.hold.policy.waitForCapacity) return { ok: false, reason: 'pool_full' };
      run.queue = { poolId: request.poolId, tiers, since: clock.now() };
    } else {
      run.claimed = claim.kind === 'claimed';
      run.attempt = host.attempt(run, memberTarget(host, run, claim, reason));
    }
  } else {
    if (!deps.router || !deps.allowed.has(deps.router.releaseId))
      return { ok: false, reason: 'unsupported' };
    run.attempt = host.attempt(run, routerTarget(host, run, request.node));
  }
  if (!run.queue && !run.attempt) return { ok: false, reason: 'segments_exhausted' };
  if (transfer !== undefined) host.transfers = Math.max(host.transfers, transfer);
  return {
    ok: true,
    run,
    state: run.queue ? 'queued' : run.attempt?.ready ? 'ready' : 'preparing',
  };
}

function holdSource(policy: ConnectHost['deps']['policy'], target?: TransferTarget): HoldSource {
  if (target?.hold) return 'target';
  return policy?.hold ? 'point' : 'default';
}

/** An agent release target: the request's `ovo_route_*` values and the call's captured ones. */
export function agentTarget(
  host: ConnectHost,
  request: Extract<SegmentHandoffRequest, { kind: 'agent' }>,
  reason: SegmentReason,
): AttemptTarget {
  return {
    ...{ agentId: request.agentId, releaseId: request.releaseId, variables: request.variables },
    ...{ role: 'agent', reason, ...capturedFor(host.deps) },
    ...(request.route?.poolId ? { poolId: request.route.poolId } : {}),
    ...(request.route?.memberId ? { memberId: request.route.memberId } : {}),
    ...(request.route?.claimId ? { claimId: request.route.claimId } : {}),
  };
}

/** The member a claim picked, as a target. */
export function memberTarget(
  host: ConnectHost,
  run: TransferRun,
  claim: Exclude<MemberClaim, { kind: 'full' }>,
  reason: SegmentReason,
): AttemptTarget {
  const { candidate } = claim;
  return {
    ...{ agentId: candidate.agentId, releaseId: candidate.releaseId },
    ...{ variables: run.request.variables, role: 'agent', reason },
    ...{ poolId: candidate.poolId, memberId: candidate.memberId },
    ...(claim.kind === 'claimed' ? { claimId: claim.claimId } : {}),
    ...capturedFor(host.deps),
  };
}

/** The router re-entering its tree at `node` (transfer design 7.5). */
export function routerTarget(host: ConnectHost, run: TransferRun, node: string): AttemptTarget {
  const { memory, router } = host.deps;
  const entry: RouterEntry = {
    node,
    path: [...(memory.route?.path ?? [])].slice(-32),
    context: {
      ...(memory.route?.language ? { language: memory.route.language } : {}),
      values: { ...(memory.route?.context ?? {}) },
    },
    disclosed: [...memory.disclosed],
    transfer: run.transfer ?? 1,
  };
  return {
    ...{ agentId: router!.agentId, releaseId: router!.releaseId, variables: {} },
    ...{ role: 'router', reason: 'reroute', entry },
  };
}

/** The candidate a member claim stands for (re-claiming the member a failed transfer left). */
export function memberCandidate(entry: SegmentHistoryEntry): RoutingMemberCandidate | undefined {
  if (!entry.poolId || !entry.memberId) return undefined;
  return {
    ...{ poolId: entry.poolId, memberId: entry.memberId },
    ...{ agentId: entry.agentId, releaseId: entry.releaseId },
  };
}
