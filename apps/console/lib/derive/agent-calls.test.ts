import { describe, expect, it } from 'vitest';
import {
  callsWithin,
  completionRate,
  dailyCallBuckets,
  dispositionBreakdown,
  failureCount,
  medianCompletedDurationMs,
  timeoutShareOfFailures,
  topFailureReasons,
  type CallRow,
} from './agent-calls';

const call = (overrides: Partial<CallRow>): CallRow => ({ id: 'c1', ...overrides });

describe('callsWithin', () => {
  it('keeps only calls created inside the window and excludes undated rows', () => {
    const now = Date.parse('2026-10-15T00:00:00Z');
    const rows = [
      call({ id: 'in', createdAt: new Date(now - 60_000).toISOString() }),
      call({ id: 'out', createdAt: new Date(now - 10 * 86_400_000).toISOString() }),
      call({ id: 'undated' }),
    ];
    expect(callsWithin(rows, 7 * 86_400_000, now).map((r) => r.id)).toEqual(['in']);
  });
});

describe('completionRate', () => {
  it('is null with no terminal calls, never a fake 0%', () => {
    expect(completionRate([call({ status: 'in_progress' })])).toBeNull();
  });
  it('divides completed by every terminal call, excluding running ones', () => {
    const rows = [
      call({ status: 'completed' }),
      call({ status: 'completed' }),
      call({ status: 'failed' }),
      call({ status: 'cancelled' }),
      call({ status: 'in_progress' }),
    ];
    expect(completionRate(rows)).toBeCloseTo(0.5);
  });
});

describe('timeoutShareOfFailures', () => {
  it('reads the structured timeout reason, not a free-text guess', () => {
    const rows = [
      call({ status: 'failed', outcome: { endReason: 'error:timeout:stt' } as never }),
      call({ status: 'failed', outcome: { endReason: 'caller_hangup' } as never }),
    ];
    expect(timeoutShareOfFailures(rows)).toBeCloseTo(0.5);
  });
  it('is null when there are no failures at all', () => {
    expect(timeoutShareOfFailures([call({ status: 'completed' })])).toBeNull();
  });
});

describe('medianCompletedDurationMs', () => {
  it('takes the midpoint of an odd count and the average of an even one', () => {
    const base = '2026-10-15T00:00:00Z';
    const row = (ms: number) =>
      call({
        status: 'completed',
        createdAt: base,
        completedAt: new Date(Date.parse(base) + ms).toISOString(),
      });
    expect(medianCompletedDurationMs([row(1000), row(2000), row(3000)])).toBe(2000);
    expect(medianCompletedDurationMs([row(1000), row(2000), row(3000), row(4000)])).toBe(2500);
  });
  it('ignores calls still running', () => {
    expect(medianCompletedDurationMs([call({ status: 'in_progress' })])).toBeNull();
  });
});

describe('dispositionBreakdown', () => {
  it('buckets a null disposition as its own honest label instead of dropping the call', () => {
    const rows = [
      call({ outcome: { disposition: 'promised_to_pay' } as never }),
      call({ outcome: null }),
    ];
    const breakdown = dispositionBreakdown(rows);
    expect(breakdown).toContainEqual({ label: 'promised_to_pay', value: 1 });
    expect(breakdown).toContainEqual({ label: 'No disposition', value: 1 });
  });
});

describe('topFailureReasons', () => {
  it('labels a timeout by stage and provider, and sorts most frequent first', () => {
    const rows = [
      call({ status: 'failed', outcome: { endReason: 'error:timeout:stt:deepgram' } as never }),
      call({ status: 'failed', outcome: { endReason: 'error:timeout:stt:deepgram' } as never }),
      call({ status: 'failed', outcome: { endReason: 'caller_hangup' } as never }),
    ];
    expect(topFailureReasons(rows)[0]).toEqual({ label: 'stt (deepgram)', count: 2 });
  });
});

describe('dailyCallBuckets', () => {
  it('includes a zero-count day rather than skipping it', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const buckets = dailyCallBuckets([], 3, now);
    expect(buckets).toHaveLength(3);
    expect(buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });
});
