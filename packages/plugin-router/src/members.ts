import type {
  MemberClaim,
  PoolSnapshot,
  RouteContext,
  RoutingHost,
  RoutingMemberCandidate,
  RoutingTarget,
} from '@winsendotai/ovo-contracts';
import { isOpen } from './hours.ts';

type PoolTarget = Extract<RoutingTarget, { kind: 'pool' }>;
type Member = PoolSnapshot['members'][number];

/** The product the target asks for: a fixed list, or the route context value it names. */
function wantedProducts(target: PoolTarget, context: RouteContext): string[] | undefined {
  if (!target.products) return undefined;
  if ('values' in target.products) return target.products.values;
  const value = context.values[target.products.context];
  // The router never learned the product: every member is a candidate rather than none.
  return value === undefined ? undefined : [value];
}

function open(member: Member, now: number): boolean {
  if (!member.hours) return true;
  try {
    return isOpen(member.hours, now);
  } catch {
    // A zone this runtime does not know: the member cannot be shown to be open.
    return false;
  }
}

/** One member against the target's non-language gates; the single predicate `eligibleTiers` and `explainPool` share. */
export interface MemberScreen {
  member: Member;
  /** Null: the member has no hours (always open). An unknown zone reads closed. */
  open: boolean | null;
  productOk: boolean;
  skillsOk: boolean;
  /** Enabled, open, offering a wanted product and every wanted skill. */
  ready: boolean;
}

export interface PoolScreen {
  /** The products the target asks for, if any. */
  products: string[] | undefined;
  /** The languages tried, in order (a `caller` target only). */
  languages: string[] | undefined;
  /** The language the members were chosen on: the first tried that a ready member speaks. */
  languageUsed: string | undefined;
  screens: MemberScreen[];
  /** The ready members that also speak `languageUsed` (every ready member for an `any` target). */
  speaking: Member[];
}

/**
 * Screens every member of `pool` for `target` (§7.5 step 4): enabled, open by their hours, offering
 * a wanted product and every wanted skill, and, for a `caller` target, speaking the caller's
 * language (the default language until one is known), else the pool's first `languageFallback`
 * language any ready member speaks.
 */
export function screenPool(input: {
  pool: PoolSnapshot;
  target: PoolTarget;
  context: RouteContext;
  defaultLanguage: string;
  now: number;
}): PoolScreen {
  const { pool, target, context, now } = input;
  const products = wantedProducts(target, context);
  const screens = pool.members.map((member): MemberScreen => {
    const hours = member.hours ? open(member, now) : null;
    const productOk = !products || products.some((product) => member.products.includes(product));
    const skillsOk = target.skills.every((skill) => member.skills.includes(skill));
    return {
      member,
      open: hours,
      productOk,
      skillsOk,
      ready: member.enabled && hours !== false && productOk && skillsOk,
    };
  });
  const ready = screens.filter((screen) => screen.ready).map((screen) => screen.member);
  if (target.language !== 'caller')
    return { products, languages: undefined, languageUsed: undefined, screens, speaking: ready };
  const languages = [context.language ?? input.defaultLanguage, ...pool.languageFallback];
  for (const language of languages) {
    const speaking = ready.filter((member) => member.languages.includes(language));
    if (speaking.length) return { products, languages, languageUsed: language, screens, speaking };
  }
  return { products, languages, languageUsed: undefined, screens, speaking: [] };
}

/** Members grouped by priority, highest first; each tier keeps the pool's member order. */
export function priorityTiers(
  poolId: string,
  members: readonly Member[],
): RoutingMemberCandidate[][] {
  const tiers = new Map<number, RoutingMemberCandidate[]>();
  for (const member of members) {
    const tier = tiers.get(member.priority) ?? [];
    tier.push({
      poolId,
      memberId: member.id,
      agentId: member.agent.agentId,
      releaseId: member.agent.release.releaseId,
      ...(member.capacity !== undefined ? { capacity: member.capacity } : {}),
    });
    tiers.set(member.priority, tier);
  }
  return [...tiers.entries()].sort((a, b) => b[0] - a[0]).map(([, tier]) => tier);
}

/**
 * The members of `pool` the target may reach now, grouped into tiers by priority, highest first
 * (§7.5 step 4; the gates are `screenPool`'s). Empty when none is.
 */
export function eligibleTiers(input: {
  pool: PoolSnapshot;
  target: PoolTarget;
  context: RouteContext;
  defaultLanguage: string;
  now: number;
}): RoutingMemberCandidate[][] {
  return priorityTiers(input.pool.id, screenPool(input).speaking);
}

/**
 * The members of a tier with room, least loaded first, exactly as the claim store ranks them: by
 * active/capacity (unlimited counts as 0), then by active claims (so unlimited members still
 * balance), then by member id and pool id. `active` is the member's current claim count.
 */
export function rankCandidates(
  tier: readonly RoutingMemberCandidate[],
  active: (candidate: RoutingMemberCandidate) => number,
): RoutingMemberCandidate[] {
  const load = (candidate: RoutingMemberCandidate, count: number) =>
    candidate.capacity === undefined ? 0 : count / candidate.capacity;
  return tier
    .map((candidate) => ({ candidate, count: active(candidate) }))
    .filter(
      ({ candidate, count }) => candidate.capacity === undefined || count < candidate.capacity,
    )
    .sort(
      (a, b) =>
        load(a.candidate, a.count) - load(b.candidate, b.count) ||
        a.count - b.count ||
        a.candidate.memberId.localeCompare(b.candidate.memberId) ||
        a.candidate.poolId.localeCompare(b.candidate.poolId),
    )
    .map(({ candidate }) => candidate);
}

export type MemberPick =
  | Extract<MemberClaim, { kind: 'claimed' | 'unclaimed' }>
  | { kind: 'failed'; reason: 'pool_missing' | 'no_eligible_member' | 'pool_full' };

/**
 * Picks a member of a pool target and claims its capacity through the host, which chooses the
 * least-loaded member with room in the first tier that has one. `full` and an empty candidate list
 * fail (the node's fallback chain moves on). Capacity is soft: claim storage being unavailable, or
 * the host throwing, proceeds with the first candidate, unclaimed (§8.2 fail-open).
 */
export async function pickMember(input: {
  pools: Readonly<Record<string, PoolSnapshot>>;
  target: PoolTarget;
  context: RouteContext;
  defaultLanguage: string;
  host: Pick<RoutingHost, 'claim' | 'now'>;
  signal: AbortSignal;
}): Promise<MemberPick> {
  const pool = input.pools[input.target.poolId];
  if (!pool) return { kind: 'failed', reason: 'pool_missing' };
  const tiers = eligibleTiers({ ...input, pool, now: input.host.now() });
  if (!tiers.length) return { kind: 'failed', reason: 'no_eligible_member' };
  let claim: MemberClaim;
  try {
    claim = await input.host.claim(tiers, input.signal);
  } catch {
    input.signal.throwIfAborted();
    claim = { kind: 'unclaimed', candidate: tiers[0]![0]!, reason: 'claims_unavailable' };
  }
  return claim.kind === 'full' ? { kind: 'failed', reason: 'pool_full' } : claim;
}
