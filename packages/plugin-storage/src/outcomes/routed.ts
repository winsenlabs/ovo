import type { CallOutcomeSummary, RoutingStats } from '@winsendotai/ovo-contracts';

/**
 * Routed-call reads (R4): which calls took which route, and what routing did in a window. The
 * filters and the stats are defined once here as pure functions over a summary, which the memory
 * store runs and the PostgreSQL queries mirror; the PostgreSQL suite holds the two to the same
 * answers.
 */
export interface RoutedCallFilter {
  pointId?: string;
  routingReleaseId?: string;
  /** Any segment ran this agent. */
  segmentAgentId?: string;
  /** The route or any segment claimed from this pool (and, with `memberId`, this member). */
  poolId?: string;
  memberId?: string;
  /** At least one transfer connected. */
  transferred?: boolean;
  /** The call has a human queue handoff. */
  human?: boolean;
  /** A fallback step was taken or failed, or the route was degraded. */
  fallback?: boolean;
  since?: string;
  until?: string;
}

export interface RoutedCallPage {
  items: { callId: string; updatedAt: string }[];
  nextCursor: string | null;
}

export const ROUTED_PAGE_MAX = 100;

export function routedPageLimit(limit = 50): number {
  return Math.max(1, Math.min(ROUTED_PAGE_MAX, Math.trunc(limit)));
}

const invalidCursor = () =>
  Object.assign(new Error('Invalid pagination cursor'), {
    statusCode: 400,
    code: 'invalid_cursor',
  });

/** `base64url(updated_at|call_id)`: the sort key, so a page boundary survives ties. */
export function encodeRoutedCursor(updatedAt: string, callId: string): string {
  return Buffer.from(`${updatedAt}|${callId}`, 'utf8').toString('base64url');
}

export function decodeRoutedCursor(cursor: string | undefined):
  | {
      updatedAt: string;
      callId: string;
    }
  | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) throw invalidCursor();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const split = text.indexOf('|');
  const updatedAt = text.slice(0, split);
  const callId = text.slice(split + 1);
  if (split < 0 || !callId || Number.isNaN(Date.parse(updatedAt))) throw invalidCursor();
  return { updatedAt: new Date(updatedAt).toISOString(), callId };
}

const count = (value: number | undefined) => value ?? 0;
/** A fallback step ran or the route was degraded: what the `fallback` filter and the stats call a fallback. */
export const usedFallback = (summary: CallOutcomeSummary): boolean =>
  count(summary.route?.fallbacks) > 0 || summary.route?.degraded != null;

export function matchesRouted(summary: CallOutcomeSummary, filter: RoutedCallFilter): boolean {
  const { route } = summary;
  if (!route) return false;
  const at = Date.parse(summary.updatedAt);
  if (filter.since !== undefined && at < Date.parse(filter.since)) return false;
  if (filter.until !== undefined && at >= Date.parse(filter.until)) return false;
  if (filter.pointId !== undefined && route.routingPointId !== filter.pointId) return false;
  if (filter.routingReleaseId !== undefined && route.routingReleaseId !== filter.routingReleaseId)
    return false;
  if (
    filter.segmentAgentId !== undefined &&
    !summary.segments.some((segment) => segment.agentId === filter.segmentAgentId)
  )
    return false;
  const claimed = (key: 'poolId' | 'memberId', wanted: string | undefined) =>
    wanted === undefined ||
    route[key] === wanted ||
    summary.segments.some((segment) => segment[key] === wanted);
  if (!claimed('poolId', filter.poolId) || !claimed('memberId', filter.memberId)) return false;
  if (filter.transferred !== undefined && summary.transfers.connected > 0 !== filter.transferred)
    return false;
  if (filter.human !== undefined && (summary.human !== null) !== filter.human) return false;
  if (filter.fallback !== undefined && usedFallback(summary) !== filter.fallback) return false;
  return true;
}

/** Newest first, ties by call id, after the cursor. */
export function pageRouted(
  summaries: Iterable<CallOutcomeSummary>,
  filter: RoutedCallFilter,
  limit: number,
  cursor: { updatedAt: string; callId: string } | undefined,
): RoutedCallPage {
  const rows = [...summaries]
    .filter((summary) => matchesRouted(summary, filter))
    .map((summary) => ({ callId: summary.callId, at: Date.parse(summary.updatedAt) }))
    .sort((a, b) => b.at - a.at || (a.callId < b.callId ? 1 : a.callId > b.callId ? -1 : 0));
  const after = cursor && { at: Date.parse(cursor.updatedAt), callId: cursor.callId };
  const rest = after
    ? rows.filter((row) => row.at < after.at || (row.at === after.at && row.callId < after.callId))
    : rows;
  const page = rest.slice(0, limit + 1);
  const more = page.length > limit;
  if (more) page.pop();
  const items = page.map((row) => ({
    callId: row.callId,
    updatedAt: new Date(row.at).toISOString(),
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: more && last ? encodeRoutedCursor(last.updatedAt, last.callId) : null,
  };
}

export interface RouteStatsQuery {
  since: string;
  until: string;
  bucket: 'hour' | 'day';
  pointId?: string;
}
export type RouteStatsResult = Pick<RoutingStats, 'totals' | 'series' | 'points' | 'pools'>;

export const BUCKET_MS = { hour: 3_600_000, day: 86_400_000 } as const;
export const ROUTE_STATS_POINTS = 50;

/** `p` in 0..1 over an ascending list, interpolated like PostgreSQL's `percentile_cont`. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (position - low) * (sorted[high]! - sorted[low]!);
}

export function foldRouteStats(
  summaries: Iterable<CallOutcomeSummary>,
  query: RouteStatsQuery,
): RouteStatsResult {
  const size = BUCKET_MS[query.bucket];
  const first = Math.floor(Date.parse(query.since) / size);
  const last = Math.floor((Date.parse(query.until) - 1) / size);
  const series = new Map<number, RouteStatsResult['series'][number]>();
  for (let bucket = first; bucket <= last; bucket += 1)
    series.set(bucket, {
      at: new Date(bucket * size).toISOString(),
      routed: 0,
      agent: 0,
      human: 0,
      end: 0,
      callback: 0,
      fallback: 0,
    });
  const totals: RouteStatsResult['totals'] = {
    routed: 0,
    undecided: 0,
    byTarget: { agent: 0, human: 0, end: 0, callback: 0 },
    degraded: 0,
    withFallback: 0,
    withReask: 0,
    transferred: 0,
    reachedPerson: 0,
    avgTurns: null,
    routeMsP50: null,
    routeMsP95: null,
  };
  const turns: number[] = [];
  const routeMs: number[] = [];
  const points = new Map<string, RouteStatsResult['points'][number]>();
  const pools = new Map<string, RouteStatsResult['pools'][number]>();
  const filter = { since: query.since, until: query.until, pointId: query.pointId };
  for (const summary of summaries) {
    if (!matchesRouted(summary, filter)) continue;
    const route = summary.route!;
    const decided = route.routingPointId !== '';
    const fallback = usedFallback(summary);
    const row = series.get(Math.floor(Date.parse(summary.updatedAt) / size))!;
    totals.routed += 1;
    row.routed += 1;
    if (fallback) {
      totals.withFallback += 1;
      row.fallback += 1;
    }
    if (route.degraded != null) totals.degraded += 1;
    if (count(route.reasks) > 0) totals.withReask += 1;
    if (summary.transfers.connected > 0) totals.transferred += 1;
    if ((summary.human?.connected ?? 0) > 0) totals.reachedPerson += 1;
    if (!decided) {
      totals.undecided += 1;
      continue;
    }
    totals.byTarget[route.target] += 1;
    row[route.target] += 1;
    if (route.turns != null) turns.push(route.turns);
    if (route.routeMs != null) routeMs.push(route.routeMs);
    const point = points.get(route.routingPointId) ?? {
      pointId: route.routingPointId,
      routed: 0,
      withFallback: 0,
      human: 0,
    };
    point.routed += 1;
    if (fallback) point.withFallback += 1;
    if (summary.human !== null) point.human += 1;
    points.set(route.routingPointId, point);
    if (route.poolId) {
      const pool = pools.get(route.poolId) ?? { poolId: route.poolId, picks: 0, byMember: {} };
      pool.picks += 1;
      if (route.memberId) pool.byMember[route.memberId] = (pool.byMember[route.memberId] ?? 0) + 1;
      pools.set(route.poolId, pool);
    }
  }
  turns.sort((a, b) => a - b);
  routeMs.sort((a, b) => a - b);
  totals.avgTurns = turns.length ? turns.reduce((sum, n) => sum + n, 0) / turns.length : null;
  totals.routeMsP50 = percentile(routeMs, 0.5);
  totals.routeMsP95 = percentile(routeMs, 0.95);
  const byRouted = (a: { routed: number; pointId: string }, b: typeof a) =>
    b.routed - a.routed || (a.pointId < b.pointId ? -1 : 1);
  return {
    totals,
    series: [...series.values()],
    points: [...points.values()].sort(byRouted).slice(0, ROUTE_STATS_POINTS),
    pools: [...pools.values()]
      .sort((a, b) => b.picks - a.picks || (a.poolId < b.poolId ? -1 : 1))
      .slice(0, ROUTE_STATS_POINTS),
  };
}
