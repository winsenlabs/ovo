import {
  RoutingEngineError,
  type MemberClaim,
  type RoutingHost,
  type RoutingMemberCandidate,
} from '@winsendotai/ovo-contracts';
import { rankCandidates } from '../members.ts';

/** The simulated clock: it moves only when the simulator moves it (a caller turn, a live engine's wait). */
export interface SimClock {
  readonly start: number;
  now(): number;
  advance(ms: number): void;
}

export function createSimClock(start: number): SimClock {
  let now = start;
  return { start, now: () => now, advance: (ms) => void (now += Math.max(0, ms)) };
}

/** `poolId:memberId`, the key load and capacity faults are given under. */
export const memberKey = (poolId: string, memberId: string) => `${poolId}:${memberId}`;

export interface SimHostInput {
  clock: SimClock;
  call: RoutingHost['call'];
  /** Active claims per `memberKey` (the workspace's live load, or none). */
  load: Readonly<Record<string, number>>;
  /** Members treated as at capacity whatever their load (a fault). */
  full: ReadonlySet<string>;
  /** A live external engine's transport; absent, the host reports it disabled. */
  external?: RoutingHost['external'];
}

/**
 * A `RoutingHost` that claims like `RoutingClaims` without writing: the first tier with a member
 * that has room answers with the least loaded one (same order as the claim store, `rankCandidates`).
 * Nothing is reserved, so a second claim in one run sees the same load; the simulator never
 * dials, counts or persists anything.
 */
export function createSimHost(input: SimHostInput): RoutingHost {
  let claimed = 0;
  return {
    call: input.call,
    now: () => input.clock.now(),
    async claim(tiers) {
      for (const tier of tiers) {
        const [pick] = rankCandidates(
          tier.filter((candidate) => !input.full.has(keyOf(candidate))),
          (candidate) => input.load[keyOf(candidate)] ?? 0,
        );
        if (pick) {
          claimed += 1;
          return claim(claimed, pick);
        }
      }
      return { kind: 'full' };
    },
    external: (request, signal) =>
      input.external
        ? input.external(request, signal)
        : Promise.reject(new RoutingEngineError('disabled', 'disabled')),
  };
}

const keyOf = (candidate: RoutingMemberCandidate) =>
  memberKey(candidate.poolId, candidate.memberId);

function claim(counter: number, candidate: RoutingMemberCandidate): MemberClaim {
  return {
    kind: 'claimed',
    claimId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    candidate,
  };
}
