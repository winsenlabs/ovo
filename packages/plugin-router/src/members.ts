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

/**
 * The members of `pool` the target may reach now, grouped into tiers by priority, highest first
 * (§7.5 step 4): enabled, open by their hours, offering a wanted product and every wanted skill,
 * and, for a `caller` target, speaking the caller's language (the default language until one is
 * known), else the pool's first `languageFallback` language any of them speaks. Empty when none is.
 */
export function eligibleTiers(input: {
  pool: PoolSnapshot;
  target: PoolTarget;
  context: RouteContext;
  defaultLanguage: string;
  now: number;
}): RoutingMemberCandidate[][] {
  const { pool, target, context, now } = input;
  const products = wantedProducts(target, context);
  const base = pool.members.filter(
    (member) =>
      member.enabled &&
      open(member, now) &&
      (!products || products.some((product) => member.products.includes(product))) &&
      target.skills.every((skill) => member.skills.includes(skill)),
  );
  let speaking = base;
  if (target.language === 'caller') {
    const languages = [context.language ?? input.defaultLanguage, ...pool.languageFallback];
    speaking = [];
    for (const language of languages) {
      speaking = base.filter((member) => member.languages.includes(language));
      if (speaking.length) break;
    }
  }
  const tiers = new Map<number, RoutingMemberCandidate[]>();
  for (const member of speaking) {
    const tier = tiers.get(member.priority) ?? [];
    tier.push({
      poolId: pool.id,
      memberId: member.id,
      agentId: member.agent.agentId,
      releaseId: member.agent.release.releaseId,
      ...(member.capacity !== undefined ? { capacity: member.capacity } : {}),
    });
    tiers.set(member.priority, tier);
  }
  return [...tiers.entries()].sort((a, b) => b[0] - a[0]).map(([, tier]) => tier);
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
