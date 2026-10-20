import { expect } from 'vitest';
import type { CallOutcomeStore } from '../src/outcomes/index.ts';
import { ROUTING } from './outcomes-route-fixture.ts';
import { POINT_B, WINDOW, seedRoutedCalls } from './outcomes-routed-fixture.ts';

/** The stats, hand-computed from `SEEDED` (see the comments). */
export async function expectRouteStats(store: CallOutcomeStore, workspaceId: string) {
  await seedRoutedCalls(store, workspaceId);
  const stats = await store.routeStats(workspaceId, WINDOW);
  expect(stats.totals).toEqual({
    routed: 7, // every call but the direct one
    undecided: 1, // c-undec hung up while routing
    byTarget: { agent: 4, human: 1, end: 1, callback: 0 }, // c-hi c-en c-def c-xfer | c-human | c-end
    degraded: 1, // c-end
    withFallback: 2, // c-def (default) and c-end (end, degraded); a skipped step and a reask do not count
    withReask: 1, // c-hi
    transferred: 1, // c-xfer
    reachedPerson: 1, // c-human connected
    avgTurns: 11 / 6, // 2 + 1 + 3 + 2 + 2 + 1 over the six decided calls
    routeMsP50: 2_050, // [500 1000 2000 2100 3000 4000]: between 2000 and 2100
    routeMsP95: 3_750,
  });
  expect(stats.series).toEqual([
    {
      at: '2026-10-20T10:00:00.000Z',
      routed: 2,
      agent: 2,
      human: 0,
      end: 0,
      callback: 0,
      fallback: 0,
    },
    {
      at: '2026-10-20T11:00:00.000Z',
      routed: 2,
      agent: 1,
      human: 1,
      end: 0,
      callback: 0,
      fallback: 1,
    },
    {
      at: '2026-10-20T12:00:00.000Z',
      routed: 3,
      agent: 1,
      human: 0,
      end: 1,
      callback: 0,
      fallback: 1,
    },
  ]);
  expect(stats.points).toEqual([
    { pointId: ROUTING.point, routed: 5, withFallback: 2, human: 0 },
    { pointId: POINT_B, routed: 1, withFallback: 0, human: 1 },
  ]);
  expect(stats.pools).toEqual([
    { poolId: ROUTING.pool, picks: 3, byMember: { 'sales-hi': 2, 'sales-en': 1 } },
  ]);

  // A narrower window and one point.
  const day = await store.routeStats(workspaceId, {
    since: '2026-10-19T00:00:00.000Z',
    until: '2026-10-21T00:00:00.000Z',
    bucket: 'day',
    pointId: POINT_B,
  });
  expect(day.totals).toMatchObject({ routed: 1, byTarget: { human: 1 }, reachedPerson: 1 });
  expect(day.series).toEqual([
    {
      at: '2026-10-19T00:00:00.000Z',
      routed: 0,
      agent: 0,
      human: 0,
      end: 0,
      callback: 0,
      fallback: 0,
    },
    {
      at: '2026-10-20T00:00:00.000Z',
      routed: 1,
      agent: 0,
      human: 1,
      end: 0,
      callback: 0,
      fallback: 0,
    },
  ]);

  // Nothing in the window, and another workspace: empty buckets, null percentiles.
  const empty = await store.routeStats(`${workspaceId}-none`, WINDOW);
  expect(empty.totals).toMatchObject({
    routed: 0,
    avgTurns: null,
    routeMsP50: null,
    routeMsP95: null,
  });
  expect(empty.series.map((row) => row.routed)).toEqual([0, 0, 0]);
  expect(empty.points).toEqual([]);
  const before = await store.routeStats(workspaceId, {
    ...WINDOW,
    since: '2026-10-01T00:00:00.000Z',
    until: '2026-10-01T02:00:00.000Z',
  });
  expect(before.totals.routed).toBe(0);
  expect(before.series).toHaveLength(2);
}
