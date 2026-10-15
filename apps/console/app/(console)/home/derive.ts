import { timeoutOf, type PerformanceGroupResult } from '@winsendotai/ovo-contracts';
import { humaniseEnum, statusTone } from '../../../lib/status';
import type { HomeCall } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface CallKpis {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  timeouts: number;
  completionRate: number | null;
  medianDurationMs: number | null;
}

export function callKpis(calls: readonly HomeCall[]): CallKpis {
  const completed = calls.filter((call) => statusTone(call.status) === 'ok').length;
  const failed = calls.filter((call) => statusTone(call.status) === 'danger').length;
  const cancelled = calls.filter((call) => statusTone(call.status) === 'neutral').length;
  const timeouts = calls.filter((call) => timeoutOf(call.outcome?.endReason ?? '')).length;
  const denominator = completed + failed + cancelled;
  const durations = calls
    .filter((call) => call.completedAt && call.createdAt)
    .map((call) => Date.parse(call.completedAt!) - Date.parse(call.createdAt!))
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  const medianDurationMs = durations.length ? durations[Math.floor(durations.length / 2)]! : null;
  return {
    total: calls.length,
    completed,
    failed,
    cancelled,
    timeouts,
    completionRate: denominator ? completed / denominator : null,
    medianDurationMs,
  };
}

/** Calls per bucket (hour inside 24h, else day), split into up to 4 status series for the
 * stacked primary visual, newest bucket last. */
export function callsByBucket(
  calls: readonly HomeCall[],
  rangeDays: number,
): { category: string; values: Record<string, number> }[] {
  const bucketMs = rangeDays <= 2 ? HOUR_MS : DAY_MS;
  const buckets = new Map<number, Record<string, number>>();
  for (const call of calls) {
    const at = Date.parse(call.createdAt ?? '');
    if (!Number.isFinite(at)) continue;
    const key = Math.floor(at / bucketMs) * bucketMs;
    const tone = statusTone(call.status);
    const bucket = buckets.get(key) ?? { ok: 0, danger: 0, info: 0, neutral: 0 };
    bucket[tone === 'warn' ? 'info' : tone] = (bucket[tone === 'warn' ? 'info' : tone] ?? 0) + 1;
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, values]) => ({
      category:
        bucketMs === HOUR_MS
          ? new Intl.DateTimeFormat('en-IN', {
              hour: '2-digit',
              hour12: false,
              timeZone: 'Asia/Kolkata',
            }).format(new Date(key))
          : new Intl.DateTimeFormat('en-IN', {
              day: '2-digit',
              month: 'short',
              timeZone: 'Asia/Kolkata',
            }).format(new Date(key)),
      values,
    }));
}

export function dispositionSlices(calls: readonly HomeCall[]): { label: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const label = call.outcome?.disposition
      ? humaniseEnum(call.outcome.disposition)
      : 'No disposition';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
}

/** "<stage>(+<provider>)" bars for calls that ended in a timeout, newest-matters-most sort. */
export function failureReasonBars(
  calls: readonly HomeCall[],
): { category: string; values: Record<string, number> }[] {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const timeout = timeoutOf(call.outcome?.endReason ?? '');
    if (!timeout) continue;
    const label = `${humaniseEnum(timeout.stage)}${timeout.provider ? ` (${timeout.provider})` : ''}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([category, count]) => ({ category, values: { count } }));
}

/** Picks the performance stage group for the KPI strip's "first-audio p95" card: the group whose
 * stage name says first-audio, or — when no stage is named that in this install — the stage with
 * the most samples, never a hardcoded stage id (brief §3 Home KPI strip note). */
export function firstAudioGroup(
  groups: readonly PerformanceGroupResult[],
): PerformanceGroupResult | undefined {
  if (!groups.length) return undefined;
  const named = groups.find((group) => {
    const stage = group.cohort.stage?.toLowerCase() ?? '';
    return stage.includes('first') && stage.includes('audio');
  });
  if (named) return named;
  return [...groups].sort((a, b) => b.sampleCount - a.sampleCount)[0];
}
