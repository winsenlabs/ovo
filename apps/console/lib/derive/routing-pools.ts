import type { PoolMember, RoutingHours, RoutingPoolDefinition } from '@winsendotai/ovo-contracts';
import type { PoolUtilisation } from '../types/routing';

export type PoolDefinition = RoutingPoolDefinition;
export type { PoolMember };

export function blankMember(id: string, agentId = ''): PoolMember {
  return {
    id,
    agent: { agentId, release: { kind: 'latest' } },
    languages: ['en'],
    products: [],
    skills: [],
    priority: 50,
    enabled: true,
  };
}

export function blankPool(name: string, agentId = ''): PoolDefinition {
  return { name, members: [blankMember('member_1', agentId)], languageFallback: [] };
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** "Mon-Fri 09:00-18:00 Asia/Kolkata" for a member's hours; "Always open" without them. */
export function hoursSummary(hours: RoutingHours | undefined): string {
  if (!hours) return 'Always open';
  const open = DAYS.filter((day) => hours.weekly[day]?.length);
  if (!open.length) return `Closed all week (${hours.timezone})`;
  const first = hours.weekly[open[0]!]![0]!;
  const same = open.every(
    (day) =>
      hours.weekly[day]!.length === 1 &&
      hours.weekly[day]![0]!.start === first.start &&
      hours.weekly[day]![0]!.end === first.end,
  );
  const cap = (day: string) => day[0]!.toUpperCase() + day.slice(1);
  const days =
    open.length === 1
      ? cap(open[0]!)
      : DAYS.indexOf(open.at(-1)!) - DAYS.indexOf(open[0]!) === open.length - 1
        ? `${cap(open[0]!)}-${cap(open.at(-1)!)}`
        : open.map(cap).join(', ');
  return `${days} ${same ? `${first.start}-${first.end}` : 'varied hours'} (${hours.timezone})`;
}

export function releaseLabel(member: PoolMember): string {
  return member.agent.release.kind === 'latest'
    ? 'Latest'
    : `Pinned ${member.agent.release.releaseId.slice(0, 8)}`;
}

/** Active calls per member from a utilisation snapshot, `undefined` when the poll has no answer yet. */
export function activeByMember(util: PoolUtilisation | undefined): Map<string, number> {
  return new Map((util?.members ?? []).map((m) => [m.memberId, m.active]));
}

/** "12 of 40", or "12 (no limit)" when a member has no capacity. */
export function loadLabel(active: number, capacity: number | null | undefined): string {
  return capacity == null ? `${active} (no limit)` : `${active} of ${capacity}`;
}

export function utilisationPercent(active: number, capacity: number | null | undefined) {
  return capacity ? Math.min(100, Math.round((active / capacity) * 100)) : null;
}

/** Languages, products and member counts of a pool for the list. */
export function poolFacts(definition: PoolDefinition) {
  const languages = [...new Set(definition.members.flatMap((m) => m.languages))].sort();
  const capacity = definition.members.every((m) => m.capacity)
    ? definition.members.reduce((sum, m) => sum + (m.enabled ? (m.capacity ?? 0) : 0), 0)
    : null;
  return {
    members: definition.members.length,
    enabled: definition.members.filter((m) => m.enabled).length,
    languages,
    capacity,
  };
}
