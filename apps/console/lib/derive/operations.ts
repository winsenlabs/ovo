// Pure, unit-tested aggregations for the Operations screens (inbound, callbacks, suppressions,
// campaigns, compliance). Nothing here fetches: every function takes already-loaded API rows and
// derives the structure (buckets, counts, chart rows) the brief asks the client to compute.
import type { CampaignRecord } from '../operator-api';

/** A callback's day bucket for the grouped table (brief: "Overdue", "Today", "Tomorrow", "Later"). */
export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'later';

// Calendar day as the operator actually reads it: in the callback's own `timezone`, not UTC.
// A callback is still grouped with "today"/"tomorrow" by what day it falls on where it is due,
// never the host server's zone or a UTC date that can land on the wrong side of the day boundary
// from IST (brief defect #2 — UTC's day rolls over 5.5 hours before IST's does, so a callback
// due in the evening IST, or a "now" read just after local midnight, could each get the wrong
// bucket). The exact due time shown to the operator is formatted the same way by `due()`, below.
const dayKey = (value: Date, timeZone: string): string => {
  try {
    // en-CA renders as YYYY-MM-DD, directly comparable and parseable as a UTC midnight below.
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(value);
  } catch {
    // swallow-ok: an unrecognised timezone falls back to UTC rather than throwing.
    return value.toISOString().slice(0, 10);
  }
};
const MS_PER_DAY = 86_400_000;

/** A pending callback already past due is "overdue" regardless of which day it fell on. */
export function dueBucket(dueAt: string, status: string, now: Date, timezone: string): DueBucket {
  const due = new Date(dueAt);
  if (status === 'pending' && due.getTime() < now.getTime()) return 'overdue';
  const dayDiff = Math.round(
    (Date.parse(`${dayKey(due, timezone)}T00:00:00Z`) -
      Date.parse(`${dayKey(now, timezone)}T00:00:00Z`)) /
      MS_PER_DAY,
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

// `Intl` has no clean short abbreviation for most IANA zone names (`Asia/Kolkata` formats as
// "GMT+5:30", not "IST"); this app dials only from India (see lib/format.ts's one operating
// zone), so a small explicit lookup beats guessing one from the offset, with the IANA name
// itself as an honest fallback for anything this product does not yet operate from.
const TIMEZONE_ABBREVIATION: Record<string, string> = { 'Asia/Kolkata': 'IST' };

/** [1,2,3,5,6] (Mon-Wed, Fri-Sat) -> "Mon–Wed, Fri–Sat"; a run of one day prints just that day. */
function dayRangesLabel(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const day = sorted[i];
    if (day === prev! + 1) {
      prev = day;
      continue;
    }
    ranges.push(
      start === prev ? DAY_NAMES[start! - 1]! : `${DAY_NAMES[start! - 1]}–${DAY_NAMES[prev! - 1]}`,
    );
    start = day;
    prev = day;
  }
  return ranges.join(', ');
}

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
  const days = window.days?.length ? ` ${dayRangesLabel(window.days)}` : '';
  const zone = TIMEZONE_ABBREVIATION[window.timezone] ?? window.timezone;
  return `Calls ${window.start}–${window.end}${days} ${zone}`;
}
