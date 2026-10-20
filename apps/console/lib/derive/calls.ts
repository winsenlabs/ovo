// Pure client-side aggregation for the calls list screen. No API/contract changes: every number
// here is derived from the `CallSummary[]` page the screen already has loaded (brief §3 CALLS —
// "every aggregation is computed client-side; no API or contract changes").
import { timeoutOf, type CallOutcomeSummary } from '@winsendotai/ovo-contracts';
import type { CallSummary } from '../api';
import type { BarSeriesPoint } from '../../components/charts/bar-chart';
import { humaniseEnum } from '../status';
import { percentile } from '../../components/inspector/turn-model';

/** The API attaches each call's recorded outcome (AGT-8), or null when none was recorded. */
export type CallRow = CallSummary & { outcome?: CallOutcomeSummary | null };

export const CALL_STATUS_KEYS = ['completed', 'in_progress', 'failed', 'cancelled'] as const;

/** `completedAt - createdAt`; null (never 0) when the call has not ended yet or is timeless. */
export function callDurationMs(call: Pick<CallRow, 'createdAt' | 'completedAt'>): number | null {
  if (!call.createdAt || !call.completedAt) return null;
  const started = Date.parse(call.createdAt);
  const ended = Date.parse(call.completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  return ended - started;
}

export interface CallsKpis {
  total: number;
  completionRate: number | null;
  completed: number;
  failed: number;
  failedTimeoutShare: number | null;
  medianDurationMs: number | null;
  liveNow: number;
}

/** Headline numbers "over the loaded window" (this page's rows, not a new aggregate endpoint). */
export function callsKpis(rows: readonly CallRow[]): CallsKpis {
  const finished = rows.filter((row) => row.status !== 'in_progress');
  const completed = rows.filter((row) => row.status === 'completed').length;
  const failedRows = rows.filter((row) => row.status === 'failed');
  const timedOut = failedRows.filter((row) => timeoutOf(row.outcome?.endReason ?? '')).length;
  const durations = rows
    .map((row) => callDurationMs(row))
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  return {
    total: rows.length,
    completionRate: finished.length ? completed / finished.length : null,
    completed,
    failed: failedRows.length,
    failedTimeoutShare: failedRows.length ? timedOut / failedRows.length : null,
    medianDurationMs: percentile(durations, 0.5),
    liveNow: rows.filter((row) => row.status === 'in_progress').length,
  };
}

export type CallsBucketGranularity = 'hour' | 'day';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_LABEL = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});
const DAY_LABEL = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Asia/Kolkata',
});
// `BarChart` labels every category (it has no sparse-tick thinning the way the axis-based charts
// do), so the bucket width has to keep the category *count* low enough for each label to have
// room — picking a plain "hourly inside 48h" width produced up to 48 crammed, overlapping ticks.
const BUCKET_STEPS_MS = [
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
] as const;
const TARGET_BUCKETS = 14;

function pickBucketMs(spanMs: number): number {
  for (const step of BUCKET_STEPS_MS) if (spanMs / step <= TARGET_BUCKETS) return step;
  return BUCKET_STEPS_MS[BUCKET_STEPS_MS.length - 1];
}

export interface CallsOverTime {
  granularity: CallsBucketGranularity;
  points: BarSeriesPoint[];
}

/** Stacked bars by status, bucketed to keep roughly `TARGET_BUCKETS` columns on screen — hourly
 * (or a coarser multiple) inside a short window, daily beyond it (brief: CALLS primary visual). */
export function callsOverTime(rows: readonly CallRow[]): CallsOverTime {
  const timestamps = rows
    .map((row) => (row.createdAt ? Date.parse(row.createdAt) : NaN))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return { granularity: 'hour', points: [] };
  const span = Math.max(...timestamps) - Math.min(...timestamps);
  const bucketMs = pickBucketMs(Math.max(span, HOUR_MS));
  const granularity: CallsBucketGranularity = bucketMs >= DAY_MS ? 'day' : 'hour';
  const buckets = new Map<number, Record<string, number>>();
  for (const row of rows) {
    const parsed = row.createdAt ? Date.parse(row.createdAt) : NaN;
    if (!Number.isFinite(parsed)) continue;
    const bucketStart = Math.floor(parsed / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart) ?? {};
    const status = row.status ?? 'unknown';
    bucket[status] = (bucket[status] ?? 0) + 1;
    buckets.set(bucketStart, bucket);
  }
  const label = granularity === 'hour' ? HOUR_LABEL : DAY_LABEL;
  const points = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, values]) => ({
      category:
        granularity === 'hour' ? `${label.format(bucketStart)}:00` : label.format(bucketStart),
      values,
    }));
  return { granularity, points };
}

/** `carrier_start` -> "Carrier start"; short Title Case labels for charts, kept local since the
 * shared `humaniseEnum` would render an already-lowercase acronym like `stt` as "Stt". */
const STAGE_CHART_LABELS: Record<string, string> = {
  carrier_start: 'Carrier start',
  route_resolve: 'Route resolve',
  worker_dial: 'Worker dial',
  media_idle: 'Media idle',
  session_open: 'Session open',
  stt: 'STT',
  tts: 'TTS',
  llm: 'LLM',
  decision: 'Decision',
  tool: 'Tool call',
};

/** `EndReason`'s own `kind:detail` shape (`agent_end:goodbye`) humanised by `humaniseEnum` alone
 * reads as "Agent end:goodbye" — the colon survives untouched and the result runs long for the
 * end-reasons bar's fixed label gutter. These are the concrete values the call outcome actually
 * carries; anything else still falls back to the plain humanised string. */
const END_REASON_LABELS: Record<string, string> = {
  caller_hangup: 'Caller hung up',
  'agent_end:goodbye': 'Said goodbye',
  'agent_end:disposition': 'Disposition set',
  max_duration: 'Max duration',
  voicemail: 'Voicemail',
};

/** "Timed out · STT" for a timeout end reason, else a short, human end-reason label (OBS-9). */
export function endReasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Unknown';
  const timeout = timeoutOf(reason);
  if (!timeout) return END_REASON_LABELS[reason] ?? humaniseEnum(reason);
  const stage = STAGE_CHART_LABELS[timeout.stage] ?? humaniseEnum(timeout.stage);
  return `Timed out · ${stage}${timeout.provider ? ` (${timeout.provider})` : ''}`;
}

export interface EndReasonCount {
  label: string;
  count: number;
}

/** Top N end reasons by volume, for the "end reasons" horizontal bar next to the volume chart. */
export function endReasonTop(rows: readonly CallRow[], limit = 6): EndReasonCount[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = row.outcome?.endReason;
    if (!reason) continue;
    const label = endReasonLabel(reason);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Route-tier mini-bar data for a call row's `outcome.tiers` (rule/jev/llm counts). */
export function tierShares(tiers: CallOutcomeSummary['tiers'] | undefined): {
  key: string;
  count: number;
}[] {
  if (!tiers) return [];
  return Object.entries(tiers)
    .filter(([, count]) => (count ?? 0) > 0)
    .map(([key, count]) => ({ key, count: count ?? 0 }));
}

/** What the Calls list shows of a routed call, read off its recorded outcome. */
export interface CallRouteSummary {
  pointId: string;
  target: string;
  agentReleaseId: string | null;
  segments: number;
  transferred: boolean;
  person: boolean;
  usedFallback: boolean;
}

/** Null for a direct call, and for an outcome recorded before routing existed. */
export function callRouteSummary(
  outcome: CallOutcomeSummary | null | undefined,
): CallRouteSummary | null {
  const route = outcome?.route;
  if (!route) return null;
  const extras = route as { fallbacks?: number };
  return {
    pointId: route.routingPointId,
    target: route.target,
    agentReleaseId: route.releaseId ?? null,
    segments: Math.max(route.segments ?? 0, outcome?.segments?.length ?? 0),
    transferred: (outcome?.transfers?.connected ?? 0) > 0,
    person: outcome?.human != null,
    usedFallback: (extras.fallbacks ?? 0) > 0 || route.degraded != null,
  };
}

/**
 * True when the API says it could not apply the routing filters (no outcome store). The cursor
 * hook spreads the whole response page, so the flag is on the object even though its type
 * only names `items` and `nextCursor`.
 */
export function routingFilterUnavailable(page: object): boolean {
  return (page as { filterUnavailable?: unknown }).filterUnavailable === true;
}
