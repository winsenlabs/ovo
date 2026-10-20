import type { PoolSnapshot, RouteContext, RoutingPoolTarget } from '@winsendotai/ovo-contracts';
import { priorityTiers, rankCandidates, screenPool } from './members.ts';
import type { PoolConsideration } from './wire/index.ts';

/** What `explainPool` is asked: a pool, the target reaching it, the call so far and the pool's load. */
export interface ExplainPoolInput {
  pool: PoolSnapshot;
  target: RoutingPoolTarget;
  context: RouteContext;
  defaultLanguage: string;
  /** Epoch ms the members' hours are read at. */
  now: number;
  /** Active claims per member id. Absent: every member idle. */
  load?: Readonly<Record<string, number>>;
  /** Member ids treated as at capacity whatever their load (a simulated fault). */
  fullMembers?: ReadonlySet<string>;
  /** A pool whose eligible members are all full is `queued` rather than `pool_full`. */
  waitForCapacity?: boolean;
}

type Reason = PoolConsideration['members'][number]['reasons'][number];

/**
 * Why each member of a pool is, or is not, a candidate for a target, and which one the host would
 * claim. It reads the same gates as `eligibleTiers` (`screenPool`) and ranks with the claim
 * store's own order (`rankCandidates`), so it cannot disagree with the router about who answers.
 * Pure: nothing is claimed.
 */
export function explainPool(input: ExplainPoolInput): Omit<PoolConsideration, 'turn' | 'node'> {
  const { pool, target, context } = input;
  const screen = screenPool(input);
  const tiers = priorityTiers(pool.id, screen.speaking);
  const tierOf = new Map(tiers.flatMap((tier, index) => tier.map((c) => [c.memberId, index])));
  const load = (memberId: string) => input.load?.[memberId] ?? 0;
  const fault = (memberId: string) => input.fullMembers?.has(memberId) ?? false;
  let picked: string | undefined;
  for (const tier of tiers) {
    const open = tier.filter((candidate) => !fault(candidate.memberId));
    picked = rankCandidates(open, (candidate) => load(candidate.memberId))[0]?.memberId;
    if (picked) break;
  }
  const language = screen.languageUsed ?? screen.languages?.[0];
  const result = picked
    ? 'picked'
    : !tiers.length
      ? 'no_eligible_member'
      : input.waitForCapacity
        ? 'queued'
        : 'pool_full';
  return {
    poolId: pool.id,
    poolName: pool.name,
    wanted: {
      language: target.language === 'caller' ? (context.language ?? input.defaultLanguage) : null,
      languageMode: target.language,
      products: screen.products ?? null,
      skills: target.skills,
    },
    languageUsed: screen.languageUsed ?? null,
    members: screen.screens.map((entry) => {
      const { member } = entry;
      const eligible = tierOf.has(member.id);
      const active = load(member.id);
      const capacity = member.capacity ?? null;
      const forced = eligible && fault(member.id);
      const full = forced || (eligible && capacity !== null && active >= capacity);
      const languageOk =
        target.language === 'any' ||
        (language !== undefined && member.languages.includes(language));
      const reasons: Reason[] = [];
      if (!member.enabled) reasons.push('disabled');
      if (entry.open === false) reasons.push('closed');
      if (!entry.productOk) reasons.push('product');
      if (!entry.skillsOk) reasons.push('skill');
      if (!languageOk) reasons.push('language');
      if (forced) reasons.push('fault');
      else if (full) reasons.push('full');
      return {
        memberId: member.id,
        agentId: member.agent.agentId,
        releaseId: member.agent.release.releaseId,
        priority: member.priority,
        enabled: member.enabled,
        open: entry.open,
        productOk: entry.productOk,
        skillsOk: entry.skillsOk,
        languageOk,
        eligible,
        tier: tierOf.get(member.id) ?? null,
        active,
        capacity,
        full,
        picked: member.id === picked,
        reasons,
      };
    }),
    result,
  };
}
