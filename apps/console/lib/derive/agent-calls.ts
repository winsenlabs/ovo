// Pure call-derivation helpers (design brief §1 "relogic the information" + §2 "lib/derive/*.ts
// (pure and unit-tested)"). Every function here takes plain data already fetched by a feature and
// returns a shape a KPI/chart/table can render directly — none of them fetch.
// Per-agent cohort helpers (Agents list / Overview). The Calls screen's own list-level helpers
// live in `./calls`; both share its `CallRow` shape.
import { timeoutOf } from '@winsendotai/ovo-contracts';
import type { CallRow } from './calls';

export type { CallRow };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calls whose `createdAt` falls within `windowMs` of `now` (default 7 days). Unparsable or
 * missing timestamps are excluded rather than assumed recent. */
export function callsWithin(
  rows: readonly CallRow[],
  windowMs: number,
  now: number = Date.now(),
): CallRow[] {
  return rows.filter((row) => {
    if (!row.createdAt) return false;
    const at = new Date(row.createdAt).getTime();
    return Number.isFinite(at) && now - at <= windowMs && at <= now;
  });
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** completed / (completed + failed + cancelled). `null` when nothing has reached a terminal
 * state yet — never a misleading 0% or 100% for an empty cohort (brief §1.4). */
export function completionRate(rows: readonly CallRow[]): number | null {
  const terminal = rows.filter((row) => TERMINAL_STATUSES.has(row.status ?? ''));
  if (!terminal.length) return null;
  const completed = terminal.filter((row) => row.status === 'completed').length;
  return completed / terminal.length;
}

export function failureCount(rows: readonly CallRow[]): number {
  return rows.filter((row) => row.status === 'failed').length;
}

/** Share of failures whose end reason parses as a timeout (`timeoutOf`), of all failures. */
export function timeoutShareOfFailures(rows: readonly CallRow[]): number | null {
  const failed = rows.filter((row) => row.status === 'failed');
  if (!failed.length) return null;
  const timedOut = failed.filter(
    (row) => row.outcome?.endReason && timeoutOf(row.outcome.endReason),
  ).length;
  return timedOut / failed.length;
}

/** Median `completedAt - createdAt` across completed calls only, in ms. `null` with none. */
export function medianCompletedDurationMs(rows: readonly CallRow[]): number | null {
  const durations = rows
    .filter((row) => row.status === 'completed' && row.createdAt && row.completedAt)
    .map((row) => new Date(row.completedAt!).getTime() - new Date(row.createdAt!).getTime())
    .filter((ms) => Number.isFinite(ms) && ms >= 0)
    .sort((a, b) => a - b);
  if (!durations.length) return null;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[mid]! : (durations[mid - 1]! + durations[mid]!) / 2;
}

export type DispositionSlice = { label: string; value: number };

/** Groups by `outcome.disposition`, humanising `null` to "No disposition" rather than dropping
 * it — an undispositioned call is still a call (brief §1.4, "Unknown is never shown as 0"). */
export function dispositionBreakdown(rows: readonly CallRow[]): DispositionSlice[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.outcome?.disposition ?? 'No disposition';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
}

export type DayBucket = { dayStart: number; count: number };

/** One count per calendar day (UTC) from `days` ago through today, oldest first — a sparkline
 * or bar series. Days with zero calls are still present as a `0`, never omitted. */
export function dailyCallBuckets(
  rows: readonly CallRow[],
  days: number,
  now: number = Date.now(),
): DayBucket[] {
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const buckets = new Map<number, number>();
  for (let index = days - 1; index >= 0; index -= 1) buckets.set(todayStart - index * DAY_MS, 0);
  for (const row of rows) {
    if (!row.createdAt) continue;
    const at = new Date(row.createdAt).getTime();
    if (!Number.isFinite(at)) continue;
    const dayStart = Math.floor(at / DAY_MS) * DAY_MS;
    if (buckets.has(dayStart)) buckets.set(dayStart, (buckets.get(dayStart) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dayStart, count]) => ({ dayStart, count }));
}
