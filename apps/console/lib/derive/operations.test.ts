import { describe, expect, it } from 'vitest';
import type { CampaignRecord } from '../operator-api';
import {
  allZero,
  callingHoursLabel,
  campaignAttemptCounts,
  campaignAttemptLabel,
  countByKey,
  donutSlices,
  dueBucket,
  groupByDueBucket,
} from './operations';

describe('dueBucket', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  it('buckets a past-due pending callback as overdue regardless of the calendar day', () => {
    expect(dueBucket('2026-10-14T12:00:00Z', 'pending', now, 'UTC')).toBe('overdue');
  });
  it('does not call a past due time overdue once it is no longer pending', () => {
    expect(dueBucket('2026-10-14T12:00:00Z', 'dialed', now, 'UTC')).toBe('today');
  });
  it('buckets same local day as today, next day as tomorrow, and later than that as later', () => {
    expect(dueBucket('2026-10-15T20:00:00Z', 'pending', now, 'UTC')).toBe('today');
    expect(dueBucket('2026-10-16T01:00:00Z', 'pending', now, 'UTC')).toBe('tomorrow');
    expect(dueBucket('2026-10-20T01:00:00Z', 'pending', now, 'UTC')).toBe('later');
  });
  // Brief defect #2: at 05:23 IST on 15 Oct (2026-10-14T23:53:00Z), a pending callback due
  // later the same IST day, 15 Oct 23:00 IST (2026-10-15T17:30:00Z), is a later UTC calendar
  // day than "now"'s UTC calendar day (14th) — a UTC-only dayKey wrongly called that "tomorrow"
  // when the operator, reading everything in IST, sees it due later today.
  it('buckets by the callback’s own timezone across the IST/UTC day boundary, not UTC', () => {
    const nowAcrossMidnightUtc = new Date('2026-10-14T23:53:00Z'); // 05:23 IST on 15 Oct
    expect(dueBucket('2026-10-15T17:30:00Z', 'pending', nowAcrossMidnightUtc, 'Asia/Kolkata')).toBe(
      'today',
    );
    // The same instants bucketed in UTC land on the UTC-ambiguous "tomorrow" instead, showing
    // the timezone argument — not the instants themselves — is what changes the answer.
    expect(dueBucket('2026-10-15T17:30:00Z', 'pending', nowAcrossMidnightUtc, 'UTC')).toBe(
      'tomorrow',
    );
  });
});

describe('groupByDueBucket', () => {
  it('orders overdue, today, tomorrow, later and omits empty buckets', () => {
    const rows = [{ bucket: 'later' as const }, { bucket: 'overdue' as const }];
    const groups = groupByDueBucket(rows, (row) => row.bucket);
    expect(groups.map((group) => group.bucket)).toEqual(['overdue', 'later']);
    expect(groups[0].rows).toEqual([{ bucket: 'overdue' }]);
  });
});

describe('countByKey', () => {
  it('keeps every requested key at zero instead of omitting it', () => {
    const counts = countByKey([{ status: 'pending' }], ['pending', 'dialing'], (row) => row.status);
    expect(counts).toEqual({ pending: 1, dialing: 0 });
  });
});

describe('donutSlices', () => {
  it('drops zero-count keys so a single-category donut does not draw an empty slice', () => {
    const rows = [{ source: 'manual' }, { source: 'manual' }];
    const slices = donutSlices(
      rows,
      ['manual', 'import'],
      (row) => row.source,
      (key) => key,
    );
    expect(slices).toEqual([{ label: 'manual', value: 2 }]);
  });
});

describe('campaignAttemptCounts / allZero', () => {
  it('tallies attempt statuses and reports when every count is zero', () => {
    expect(campaignAttemptCounts([{ status: 'completed' }, { status: 'completed' }])).toEqual({
      completed: 2,
    });
    expect(allZero({ a: 0, b: 0 })).toBe(true);
    expect(allZero({ a: 0, b: 1 })).toBe(false);
  });
});

describe('campaignAttemptLabel', () => {
  it('humanises reconciling and superseded distinctly, and passes other statuses through', () => {
    expect(campaignAttemptLabel('unknown')).toBe('Reconciling');
    expect(campaignAttemptLabel('superseded')).toBe('Superseded');
    expect(campaignAttemptLabel('completed')).toBe('completed');
  });
});

describe('callingHoursLabel', () => {
  const base = { compliance: undefined } as unknown as CampaignRecord;
  it('collapses consecutive days into a range and abbreviates the timezone', () => {
    expect(
      callingHoursLabel({
        ...base,
        callingWindow: {
          start: '08:00',
          end: '19:00',
          days: [1, 2, 3, 4, 5, 6],
          timezone: 'Asia/Kolkata',
        },
      } as CampaignRecord),
    ).toBe('Calls 08:00–19:00 Mon–Sat IST');
    expect(callingHoursLabel({ ...base, callingWindow: null } as CampaignRecord)).toBe('Any hour');
  });
  it('keeps non-consecutive days as separate entries and falls back to the raw zone name', () => {
    expect(
      callingHoursLabel({
        ...base,
        callingWindow: { start: '09:00', end: '17:00', days: [1, 3, 5], timezone: 'Europe/London' },
      } as CampaignRecord),
    ).toBe('Calls 09:00–17:00 Mon, Wed, Fri Europe/London');
  });
});
