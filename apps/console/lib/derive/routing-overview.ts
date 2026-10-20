import { routingAudioIds, routingPoolIds } from '@winsendotai/ovo-contracts';
import type { BarSeriesPoint } from '../../components/charts/bar-chart';
import type { PointRecord, PoolUtilisation, RoutingStats } from '../types/routing';
import { clientIssues } from './routing-issues';

export const TARGET_SERIES = ['agent', 'human', 'end', 'callback'] as const;
export const TARGET_SERIES_LABEL: Record<(typeof TARGET_SERIES)[number], string> = {
  agent: 'Agent',
  human: 'Person',
  end: 'Ended',
  callback: 'Callback',
};

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/** The four KPI values; every one is `null` (the dash) when outcomes are not stored or stats failed. */
export function statsKpis(stats: RoutingStats | undefined) {
  if (!stats?.available)
    return { routed: null, fallbackRate: null, reachedPerson: null, p50: null, p95: null };
  const { totals } = stats;
  return {
    routed: totals.routed,
    fallbackRate: pct(totals.withFallback, totals.routed),
    reachedPerson: totals.reachedPerson,
    p50: totals.routeMsP50,
    p95: totals.routeMsP95,
  };
}

/** Stacked bars: one category per bucket, one series per target kind. */
export function seriesData(stats: RoutingStats | undefined): BarSeriesPoint[] {
  if (!stats?.available) return [];
  return stats.series.map((bucket) => ({
    category: bucketLabel(bucket.at, stats.bucket),
    values: {
      agent: bucket.agent,
      human: bucket.human,
      end: bucket.end,
      callback: bucket.callback,
    },
  }));
}

export function bucketLabel(at: string, bucket: 'hour' | 'day'): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return bucket === 'hour'
    ? date.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Kolkata',
      })
    : date.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        timeZone: 'Asia/Kolkata',
      });
}

export type PointState = { label: string; tone: 'ok' | 'warn' | 'neutral' };
/** Draft/published badges of a point (one or two), from the list summary. */
export function pointStates(point: PointRecord): PointState[] {
  const states: PointState[] = [{ label: `Draft v${point.draftVersion}`, tone: 'neutral' }];
  const latest = point.summary?.latestRelease;
  if (!point.summary) return states;
  if (!latest) states.push({ label: 'Never published', tone: 'warn' });
  else if (point.summary.published)
    states.push({ label: `Published v${latest.version}`, tone: 'ok' });
  else {
    states.push({ label: `Published v${latest.version}`, tone: 'neutral' });
    states.push({ label: 'Unpublished changes', tone: 'warn' });
  }
  return states;
}

/** Errors and warnings the browser can tell from a point's draft alone. */
export function pointIssueCounts(point: PointRecord) {
  const issues = clientIssues(point.draft);
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** Which points name each hold clip, from the drafts already loaded. */
export function clipUsers(
  points: readonly PointRecord[],
): Map<string, { id: string; name: string }[]> {
  const users = new Map<string, { id: string; name: string }[]>();
  for (const point of points)
    for (const clip of routingAudioIds(point.draft))
      users.set(clip, [...(users.get(clip) ?? []), { id: point.id, name: point.draft.name }]);
  return users;
}

/** Utilisation snapshots keyed by pool, for the pools table. */
export const utilisationByPool = (all: readonly PoolUtilisation[]) =>
  new Map(all.map((u) => [u.poolId, u]));

export const poolUsers = (points: readonly PointRecord[], poolId: string) =>
  points
    .filter((p) => routingPoolIds(p.draft).includes(poolId))
    .map((p) => ({ id: p.id, name: p.draft.name }));
