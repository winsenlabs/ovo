import { describe, expect, it } from 'vitest';
import { MemoryCallOutcomeStore } from '../src/outcomes/index.ts';
import {
  decodeRoutedCursor,
  encodeRoutedCursor,
  percentile,
  routedPageLimit,
} from '../src/outcomes/routed.ts';
import { expectRoutedFilters } from './outcomes-routed-fixture.ts';
import { expectRouteStats } from './outcomes-routed-stats-fixture.ts';

describe('routed call reads (Wave 18), memory store', () => {
  it('filters routed calls and pages them with a stable cursor', async () => {
    await expectRoutedFilters(new MemoryCallOutcomeStore(), 'ws-routed');
  });

  it('folds route stats', async () => {
    await expectRouteStats(new MemoryCallOutcomeStore(), 'ws-stats');
  });
});

describe('routed read helpers', () => {
  it('round-trips a cursor, including a call id with a pipe', () => {
    const cursor = encodeRoutedCursor('2026-10-20T12:10:00.000Z', 'call|with|pipes');
    expect(decodeRoutedCursor(cursor)).toEqual({
      updatedAt: '2026-10-20T12:10:00.000Z',
      callId: 'call|with|pipes',
    });
    expect(decodeRoutedCursor(undefined)).toBeUndefined();
  });

  it('rejects a malformed cursor with a 400', () => {
    for (const bad of ['', '$$$', 'bm90LWEtY3Vyc29y', encodeRoutedCursor('not a date', 'x')])
      expect(() => decodeRoutedCursor(bad), bad).toThrow(/cursor/);
    expect(() => decodeRoutedCursor('$$$')).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it('clamps the page size to 1..100', () => {
    expect([
      routedPageLimit(),
      routedPageLimit(0),
      routedPageLimit(500),
      routedPageLimit(7.9),
    ]).toEqual([50, 1, 100, 7]);
  });

  it('interpolates percentiles like PostgreSQL percentile_cont', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBe(48);
  });
});
