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
    expect(dueBucket('2026-10-14T12:00:00Z', 'pending', now)).toBe('overdue');
  });
  it('does not call a past due time overdue once it is no longer pending', () => {
    expect(dueBucket('2026-10-14T12:00:00Z', 'dialed', now)).toBe('today');
  });
  it('buckets same local day as today, next day as tomorrow, and later than that as later', () => {
    expect(dueBucket('2026-10-15T20:00:00Z', 'pending', now)).toBe('today');
    expect(dueBucket('2026-10-16T01:00:00Z', 'pending', now)).toBe('tomorrow');
    expect(dueBucket('2026-10-20T01:00:00Z', 'pending', now)).toBe('later');
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
  it('labels a campaign window and a campaign without one', () => {
    expect(
      callingHoursLabel({
        ...base,
        callingWindow: { start: '08:00', end: '19:00', days: [1, 2], timezone: 'Asia/Kolkata' },
      } as CampaignRecord),
    ).toBe('Calls 08:00–19:00 Mon,Tue Asia/Kolkata');
    expect(callingHoursLabel({ ...base, callingWindow: null } as CampaignRecord)).toBe('Any hour');
  });
});
