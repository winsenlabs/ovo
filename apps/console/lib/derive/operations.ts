// Pure, unit-tested aggregations for the Operations screens (inbound, callbacks, suppressions,
// campaigns, compliance). Nothing here fetches: every function takes already-loaded API rows and
// derives the structure (buckets, counts, chart rows) the brief asks the client to compute.
import type { CampaignRecord } from '../operator-api';

/** A callback's day bucket for the grouped table (brief: "Overdue", "Today", "Tomorrow", "Later"). */
export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'later';

// Calendar day in UTC, never the test runner's or the operator's local host timezone: each
// callback can carry its own `timezone` (the agent's), so there is no single "local day" to pick
// for grouping — UTC is the one zone every instant agrees on. The exact due time shown to the
// operator is still formatted in the record's own timezone by `due()`, below.
const dayKey = (value: Date): string => value.toISOString().slice(0, 10);
const MS_PER_DAY = 86_400_000;

/** A pending callback already past due is "overdue" regardless of which day it fell on. */
export function dueBucket(dueAt: string, status: string, now: Date): DueBucket {
  const due = new Date(dueAt);
  if (status === 'pending' && due.getTime() < now.getTime()) return 'overdue';
  const dayDiff = Math.round(
    (Date.parse(`${dayKey(due)}T00:00:00Z`) - Date.parse(`${dayKey(now)}T00:00:00Z`)) / MS_PER_DAY,
  );
  if (dayDiff <= 0) return 'today';
  if (dayDiff === 1) return 'tomorrow';
  return 'later';
}

const BUCKET_ORDER: readonly DueBucket[] = ['overdue', 'today', 'tomorrow', 'later'];
const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  later: 'Later',
};

/** Rows grouped into the four day buckets, in display order, empty buckets omitted. */
export function groupByDueBucket<T>(
  rows: readonly T[],
  bucketOf: (row: T) => DueBucket,
): { bucket: DueBucket; label: string; rows: T[] }[] {
  const groups = new Map<DueBucket, T[]>();
  for (const row of rows) {
    const bucket = bucketOf(row);
    const list = groups.get(bucket);
    if (list) list.push(row);
    else groups.set(bucket, [row]);
  }
  return BUCKET_ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    bucket,
    label: BUCKET_LABEL[bucket],
    rows: groups.get(bucket)!,
  }));
}

/** How many rows match each key, keeping every requested key even at zero (never silently 0 of N). */
export function countByKey<T>(
  rows: readonly T[],
  keys: readonly string[],
  keyOf: (row: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = 0;
  for (const row of rows) {
    const key = keyOf(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** A `{label, value}` donut slice per key, dropping zero-count keys (an empty slice draws nothing). */
export function donutSlices<T>(
  rows: readonly T[],
  keys: readonly string[],
  keyOf: (row: T) => string,
  labelOf: (key: string) => string,
): { label: string; value: number }[] {
  const counts = countByKey(rows, keys, keyOf);
  return keys
    .filter((key) => counts[key] > 0)
    .map((key) => ({ label: labelOf(key), value: counts[key] }));
}

/** A campaign's `attempts[].status` tally as one stacked-bar category, humanised keys kept raw here. */
export function campaignAttemptCounts(
  attempts: readonly { status: string }[] | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts ?? []) counts[attempt.status] = (counts[attempt.status] ?? 0) + 1;
  return counts;
}

/** True once every requested count is zero — used to decide whether a chart has nothing to draw. */
export function allZero(counts: Record<string, number>): boolean {
  return Object.values(counts).every((value) => value === 0);
}

/** `unknown` -> "Reconciling", `superseded` kept distinct from the shared status map's generic
 * wording, since a superseded attempt is not simply "cancelled". */
export function campaignAttemptLabel(status: string): string {
  return status === 'unknown' ? 'Reconciling' : status === 'superseded' ? 'Superseded' : status;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The campaign's calling-hours snapshot, as the list shows it. */
export function callingHoursLabel(campaign: CampaignRecord): string {
  const window = (
    campaign as CampaignRecord & {
      callingWindow?: { start: string; end: string; days?: number[]; timezone: string } | null;
    }
  ).callingWindow;
  // A campaign with a compliance policy keeps the agent's hours and the legal floor.
  if (!window)
    return (campaign as { compliance?: unknown }).compliance ? 'Agent hours' : 'Any hour';
  const days = window.days ? ` ${window.days.map((day) => DAY_NAMES[day - 1]).join(',')}` : '';
  return `Calls ${window.start}–${window.end}${days} ${window.timezone}`;
}
