import type { Pool } from 'pg';
import { toIso, type Row } from '../postgres/shared.ts';
import {
  BUCKET_MS,
  ROUTE_STATS_POINTS,
  encodeRoutedCursor,
  type RouteStatsQuery,
  type RouteStatsResult,
  type RoutedCallFilter,
  type RoutedCallPage,
} from './routed.ts';

/** SQL for the `usedFallback` predicate of `routed.ts`. */
const FALLBACK = `(COALESCE((route->>'fallbacks')::int, 0) > 0 OR route->>'degraded' IS NOT NULL)`;

/** The WHERE clause shared by the page and the stats; mirrors `matchesRouted`. */
function routedWhere(workspaceId: string, filter: RoutedCallFilter) {
  const params: unknown[] = [workspaceId];
  const where = ['workspace_id = $1', 'route IS NOT NULL'];
  const bind = (value: unknown) => `$${params.push(value)}`;
  if (filter.since !== undefined) where.push(`updated_at >= ${bind(filter.since)}::timestamptz`);
  if (filter.until !== undefined) where.push(`updated_at < ${bind(filter.until)}::timestamptz`);
  if (filter.pointId !== undefined)
    where.push(`route->>'routingPointId' = ${bind(filter.pointId)}`);
  if (filter.routingReleaseId !== undefined)
    where.push(`route->>'routingReleaseId' = ${bind(filter.routingReleaseId)}`);
  if (filter.segmentAgentId !== undefined)
    where.push(`segments @> ${bind(JSON.stringify([{ agentId: filter.segmentAgentId }]))}::jsonb`);
  for (const key of ['poolId', 'memberId'] as const) {
    const wanted = filter[key];
    if (wanted !== undefined)
      where.push(
        `(route->>'${key}' = ${bind(wanted)} OR segments @> ${bind(JSON.stringify([{ [key]: wanted }]))}::jsonb)`,
      );
  }
  if (filter.transferred !== undefined)
    where.push(`(COALESCE((transfers->>'connected')::int, 0) > 0) = ${bind(filter.transferred)}`);
  if (filter.human !== undefined) where.push(`(human IS NOT NULL) = ${bind(filter.human)}`);
  if (filter.fallback !== undefined) where.push(`${FALLBACK} = ${bind(filter.fallback)}`);
  return { params, where, bind };
}

export async function findRoutedPg(
  pool: Pool,
  workspaceId: string,
  filter: RoutedCallFilter,
  limit: number,
  cursor: { updatedAt: string; callId: string } | undefined,
): Promise<RoutedCallPage> {
  const { params, where, bind } = routedWhere(workspaceId, filter);
  if (cursor)
    where.push(
      `(updated_at, call_id) < (${bind(cursor.updatedAt)}::timestamptz, ${bind(cursor.callId)})`,
    );
  const result = await pool.query<Row>(
    `SELECT call_id, updated_at FROM ovo_call_outcomes WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC, call_id DESC LIMIT ${bind(limit + 1)}`,
    params,
  );
  const more = result.rows.length > limit;
  if (more) result.rows.pop();
  const items = result.rows.map((row) => ({
    callId: String(row.call_id),
    updatedAt: toIso(row.updated_at),
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor: more && last ? encodeRoutedCursor(last.updatedAt, last.callId) : null,
  };
}

const num = (value: unknown): number => Number(value ?? 0);
const orNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const DECIDED = `route->>'routingPointId' <> ''`;

export async function routeStatsPg(
  pool: Pool,
  workspaceId: string,
  query: RouteStatsQuery,
): Promise<RouteStatsResult> {
  const { params, where } = routedWhere(workspaceId, {
    since: query.since,
    until: query.until,
    ...(query.pointId === undefined ? {} : { pointId: query.pointId }),
  });
  const base = `FROM ovo_call_outcomes WHERE ${where.join(' AND ')}`;
  const size = BUCKET_MS[query.bucket] / 1000;
  const bucket = `floor(extract(epoch FROM updated_at) / ${size})::bigint`;
  const target = (name: string) =>
    `count(*) FILTER (WHERE ${DECIDED} AND route->>'target' = '${name}')::int AS ${name}`;
  const [totals, series, points, pools] = await Promise.all([
    pool.query<Row>(
      `SELECT count(*)::int AS routed,
         count(*) FILTER (WHERE NOT (${DECIDED}))::int AS undecided,
         ${['agent', 'human', 'end', 'callback'].map(target).join(', ')},
         count(*) FILTER (WHERE route->>'degraded' IS NOT NULL)::int AS degraded,
         count(*) FILTER (WHERE ${FALLBACK})::int AS with_fallback,
         count(*) FILTER (WHERE COALESCE((route->>'reasks')::int, 0) > 0)::int AS with_reask,
         count(*) FILTER (WHERE COALESCE((transfers->>'connected')::int, 0) > 0)::int AS transferred,
         count(*) FILTER (WHERE COALESCE((human->>'connected')::int, 0) > 0)::int AS reached_person,
         avg((route->>'turns')::float8) FILTER (WHERE ${DECIDED}) AS avg_turns,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY (route->>'routeMs')::float8)
           FILTER (WHERE ${DECIDED}) AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY (route->>'routeMs')::float8)
           FILTER (WHERE ${DECIDED}) AS p95
       ${base}`,
      params,
    ),
    pool.query<Row>(
      `SELECT g.b::bigint AS bucket,
         count(o.b)::int AS routed,
         ${['agent', 'human', 'end', 'callback'].map((name) => `count(o.b) FILTER (WHERE o.decided AND o.target = '${name}')::int AS ${name}`).join(', ')},
         count(o.b) FILTER (WHERE o.fallback)::int AS fallback
       FROM generate_series(
         floor(extract(epoch FROM $${params.length + 1}::timestamptz) / ${size})::bigint,
         floor((extract(epoch FROM $${params.length + 2}::timestamptz) - 0.001) / ${size})::bigint
       ) AS g(b)
       LEFT JOIN (
         SELECT ${bucket} AS b, ${DECIDED} AS decided, route->>'target' AS target, ${FALLBACK} AS fallback
         ${base}
       ) o ON o.b = g.b
       GROUP BY g.b ORDER BY g.b`,
      [...params, query.since, query.until],
    ),
    pool.query<Row>(
      `SELECT route->>'routingPointId' AS point_id, count(*)::int AS routed,
         count(*) FILTER (WHERE ${FALLBACK})::int AS with_fallback,
         count(*) FILTER (WHERE human IS NOT NULL)::int AS human
       ${base} AND ${DECIDED}
       GROUP BY 1 ORDER BY routed DESC, point_id ASC LIMIT ${ROUTE_STATS_POINTS}`,
      params,
    ),
    pool.query<Row>(
      `SELECT route->>'poolId' AS pool_id, route->>'memberId' AS member_id, count(*)::int AS picks
       ${base} AND ${DECIDED} AND route->>'poolId' IS NOT NULL
       GROUP BY 1, 2`,
      params,
    ),
  ]);
  const t = totals.rows[0]!;
  const byPool = new Map<string, RouteStatsResult['pools'][number]>();
  for (const row of pools.rows) {
    const id = String(row.pool_id);
    const entry = byPool.get(id) ?? { poolId: id, picks: 0, byMember: {} };
    entry.picks += num(row.picks);
    if (row.member_id !== null) entry.byMember[String(row.member_id)] = num(row.picks);
    byPool.set(id, entry);
  }
  return {
    totals: {
      routed: num(t.routed),
      undecided: num(t.undecided),
      byTarget: {
        agent: num(t.agent),
        human: num(t.human),
        end: num(t.end),
        callback: num(t.callback),
      },
      degraded: num(t.degraded),
      withFallback: num(t.with_fallback),
      withReask: num(t.with_reask),
      transferred: num(t.transferred),
      reachedPerson: num(t.reached_person),
      avgTurns: orNull(t.avg_turns),
      routeMsP50: orNull(t.p50),
      routeMsP95: orNull(t.p95),
    },
    series: series.rows.map((row) => ({
      at: new Date(num(row.bucket) * size * 1000).toISOString(),
      routed: num(row.routed),
      agent: num(row.agent),
      human: num(row.human),
      end: num(row.end),
      callback: num(row.callback),
      fallback: num(row.fallback),
    })),
    points: points.rows.map((row) => ({
      pointId: String(row.point_id),
      routed: num(row.routed),
      withFallback: num(row.with_fallback),
      human: num(row.human),
    })),
    pools: [...byPool.values()]
      .sort((a, b) => b.picks - a.picks || (a.poolId < b.poolId ? -1 : 1))
      .slice(0, ROUTE_STATS_POINTS),
  };
}
