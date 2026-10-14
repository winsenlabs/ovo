// Pure aggregation for the Performance screen. Every function reads `PerformanceGroupResult[]`
// already returned by the API's own cohort query — there is no client-side re-bucketing, and the
// "which stage" choice is always picked from the data (most samples), never a hardcoded name.
import type { PerformanceGroupResult } from '@winsendotai/ovo-contracts';
import type { LineSeries } from '../../components/charts/line-chart';
import type { BarSeriesPoint } from '../../components/charts/bar-chart';
import { humaniseEnum } from '../status';

export type Percentile = 'p50Ms' | 'p95Ms' | 'p99Ms';
export const LOW_SAMPLE_THRESHOLD = 20;

/** The stage with the most samples across every group in range — used for the KPI strip instead
 * of a hardcoded "first audio" stage name, which the API never promises to use. */
export function dominantStage(groups: readonly PerformanceGroupResult[]): string | null {
  const totals = new Map<string, number>();
  for (const group of groups) {
    const stage = group.cohort.stage;
    if (!stage) continue;
    totals.set(stage, (totals.get(stage) ?? 0) + group.sampleCount);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [stage, count] of totals)
    if (count > bestCount) {
      best = stage;
      bestCount = count;
    }
  return best;
}

/** The most recent time-bucketed group for one stage (requires `time` in the cohort). */
export function latestBucketFor(
  groups: readonly PerformanceGroupResult[],
  stage: string | null,
): PerformanceGroupResult | null {
  let latest: PerformanceGroupResult | null = null;
  for (const group of groups) {
    if (group.cohort.stage !== stage || !group.cohort.time) continue;
    if (!latest || group.cohort.time > latest.cohort.time!) latest = group;
  }
  return latest;
}

/** Sample-weighted totals for one stage across the whole queried range. */
export function rangeTotals(groups: readonly PerformanceGroupResult[], stage: string | null) {
  const matching = groups.filter((group) => group.cohort.stage === stage);
  return {
    calls: matching.reduce((sum, group) => sum + group.callCount, 0),
    errors: matching.reduce((sum, group) => sum + group.errors, 0),
    timeouts: matching.reduce((sum, group) => sum + group.timeouts, 0),
    samples: matching.reduce((sum, group) => sum + group.sampleCount, 0),
  };
}

/** One line series per stage (time on x), for the chosen percentile. Points are sorted so the
 * line never zig-zags when the API returns groups in an unspecified order. */
export function stageTimeSeries(
  groups: readonly PerformanceGroupResult[],
  percentile: Percentile,
): LineSeries[] {
  const byStage = new Map<string, { x: number; y: number }[]>();
  for (const group of groups) {
    const stage = group.cohort.stage;
    const time = group.cohort.time;
    const value = group[percentile];
    if (!stage || !time || value == null) continue;
    const points = byStage.get(stage) ?? [];
    points.push({ x: new Date(time).getTime(), y: value });
    byStage.set(stage, points);
  }
  return [...byStage.entries()].map(([stage, points]) => ({
    key: stage,
    label: humaniseEnum(stage),
    points: points.sort((a, b) => a.x - b.x),
  }));
}

/** p50/p95 per stage across the whole range, for a stage-only cohort query. */
export function stageBreakdownBars(groups: readonly PerformanceGroupResult[]): BarSeriesPoint[] {
  return groups
    .filter((group) => group.cohort.stage)
    .map((group) => ({
      category: humaniseEnum(group.cohort.stage!),
      values: { p50: group.p50Ms ?? 0, p95: group.p95Ms ?? 0 },
    }));
}

export type CompareDimension = 'agent' | 'release' | 'provider' | 'model' | 'language';
export type CompareBar = { category: string; p95: number; samples: number; lowSample: boolean };

/** p95 per cohort value for a "compare by" dimension, flagging thin cohorts instead of silently
 * plotting them next to well-sampled ones (brief: never compare unmatched cohorts silently). */
export function compareByBars(
  groups: readonly PerformanceGroupResult[],
  dimension: CompareDimension,
): CompareBar[] {
  return groups
    .filter((group) => group.cohort[dimension] != null && group.p95Ms != null)
    .map((group) => ({
      category: String(group.cohort[dimension]),
      p95: group.p95Ms ?? 0,
      samples: group.sampleCount,
      lowSample: group.sampleCount < LOW_SAMPLE_THRESHOLD,
    }))
    .sort((a, b) => b.p95 - a.p95);
}

/** `from=now-24h` style helper: hour buckets under 48h, day buckets beyond, so the point count
 * stays well under the API's 200-group ceiling instead of truncating (brief defect #13). */
export function autoBucket(fromMs: number, toMs: number): 'hour' | 'day' {
  return toMs - fromMs <= 48 * 3600_000 ? 'hour' : 'day';
}

const RANGE_SPAN_MS: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 3600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
};

/** The toolbar's `1h/24h/7d/30d/custom` preset -> an absolute `{fromMs,toMs}` window. */
export function resolvePerformanceRange(
  preset: '1h' | '24h' | '7d' | '30d' | 'custom',
  custom: { from: string; to: string },
): { fromMs: number; toMs: number } {
  const toMs = Date.now();
  if (preset !== 'custom') return { fromMs: toMs - RANGE_SPAN_MS[preset], toMs };
  const from = custom.from ? Date.parse(custom.from) : toMs - 86_400_000;
  const to = custom.to ? Date.parse(custom.to) : toMs;
  return {
    fromMs: Number.isFinite(from) ? from : toMs - 86_400_000,
    toMs: Number.isFinite(to) ? to : toMs,
  };
}

export type CohortFilterKey = 'provider' | 'model' | 'language' | 'stage';

/** Distinct, non-null cohort values for one dimension, for populating a filter Select from the
 * data actually returned rather than a static or separately-fetched option list. */
export function distinctCohortValues(
  groups: readonly PerformanceGroupResult[],
  key: CohortFilterKey,
): string[] {
  return [
    ...new Set(
      groups.map((group) => group.cohort[key]).filter((value): value is string => !!value),
    ),
  ];
}
