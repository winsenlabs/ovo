import { describe, expect, it } from 'vitest';
import {
  PoolConsideration,
  PoolUtilisation,
  QueueActivity,
  RoutingChange,
  RoutingStats,
  RoutingUtilisation,
} from '../src/index.ts';
import { POINT_ID, POOL_SALES } from './routing-fixture.ts';

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
const rejects = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

const AT = '2026-10-20T10:00:00.000Z';

describe('PoolUtilisation and RoutingUtilisation', () => {
  const pool = {
    poolId: POOL_SALES,
    at: AT,
    members: [
      { memberId: 'sales-en', active: 2, capacity: 4, enabled: true, open: true },
      { memberId: 'sales-hi', active: 0, capacity: null, enabled: false, open: null },
    ],
    total: { active: 2, capacity: 4 },
  };

  it('accepts a pool with bounded, unlimited, closed and unknown-hours members', () => {
    accepts(PoolUtilisation, pool);
    accepts(PoolUtilisation, { ...pool, total: { active: 0, capacity: null } });
    accepts(RoutingUtilisation, {
      at: AT,
      pools: [{ poolId: POOL_SALES, active: 3, capacity: null, unlimitedMembers: 2 }],
    });
  });

  it('rejects negative counts, a zero capacity, a bad pool id and a missing total', () => {
    rejects(PoolUtilisation, { ...pool, members: [{ ...pool.members[0], active: -1 }] });
    rejects(PoolUtilisation, { ...pool, members: [{ ...pool.members[0], capacity: 0 }] });
    rejects(PoolUtilisation, { ...pool, poolId: 'sales' });
    rejects(PoolUtilisation, { poolId: POOL_SALES, at: AT, members: [] });
    rejects(RoutingUtilisation, {
      at: AT,
      pools: [{ poolId: POOL_SALES, active: 3, capacity: 5 }],
    });
  });
});

describe('RoutingStats', () => {
  const stats = {
    available: true,
    window: '24h',
    since: '2026-10-19T10:00:00.000Z',
    until: AT,
    bucket: 'hour',
    totals: {
      routed: 4,
      undecided: 1,
      byTarget: { agent: 2, human: 1, end: 0, callback: 0 },
      degraded: 0,
      withFallback: 1,
      withReask: 1,
      transferred: 0,
      reachedPerson: 1,
      avgTurns: 2.5,
      routeMsP50: 1800,
      routeMsP95: null,
    },
    series: [{ at: AT, routed: 4, agent: 2, human: 1, end: 0, callback: 0, fallback: 1 }],
    points: [{ pointId: POINT_ID, routed: 4, withFallback: 1, human: 1 }],
    pools: [{ poolId: POOL_SALES, picks: 2, byMember: { 'sales-en': 2 } }],
  };

  it('accepts a window with data and one that is empty or not stored', () => {
    accepts(RoutingStats, stats);
    accepts(RoutingStats, { ...stats, available: false, series: [], points: [], pools: [] });
    accepts(RoutingStats, { ...stats, window: '30d', bucket: 'day' });
  });

  it('rejects an unknown window or bucket, negative counts and a missing target', () => {
    rejects(RoutingStats, { ...stats, window: '1y' });
    rejects(RoutingStats, { ...stats, bucket: 'week' });
    rejects(RoutingStats, { ...stats, totals: { ...stats.totals, routed: -1 } });
    rejects(RoutingStats, { ...stats, totals: { ...stats.totals, byTarget: { agent: 1 } } });
    rejects(RoutingStats, { ...stats, series: [{ at: 'now', routed: 1 }] });
  });
});

describe('QueueActivity', () => {
  const activity = {
    queueId: POINT_ID,
    window: '7d',
    stats: {
      created: 3,
      handled: 2,
      abandoned: 1,
      expired: 0,
      webhookFailed: 0,
      avgWaitMs: 12000,
      p95WaitMs: 30000,
      avgTalkMs: null,
      byOutcome: { ended: 2, abandoned: 1 },
    },
    tickets: [
      {
        id: POOL_SALES,
        callId: 'call-1',
        status: 'released',
        priority: 1,
        language: 'hi',
        createdAt: AT,
        waitMs: 5000,
        releasedAt: AT,
        releaseCode: 'completed',
        outcome: 'ended',
        operatorId: 'asha',
      },
      {
        id: POINT_ID,
        callId: 'call-2',
        status: 'waiting',
        priority: 0,
        createdAt: AT,
        waitMs: 100,
      },
    ],
  };

  it('accepts a busy queue, a quiet one, and a ticket with only the required fields', () => {
    accepts(QueueActivity, activity);
    accepts(QueueActivity, { ...activity, window: '24h', tickets: [] });
  });

  it('rejects a 30 day window, a made-up status or outcome, more than 50 tickets and extra ticket text', () => {
    rejects(QueueActivity, { ...activity, window: '30d' });
    rejects(QueueActivity, { ...activity, tickets: [{ ...activity.tickets[1], status: 'lost' }] });
    rejects(QueueActivity, {
      ...activity,
      stats: { ...activity.stats, byOutcome: { vanished: 1 } },
    });
    rejects(QueueActivity, {
      ...activity,
      tickets: Array.from({ length: 51 }, () => activity.tickets[1]),
    });
    rejects(QueueActivity, { ...activity, tickets: [{ ...activity.tickets[1], priority: 12 }] });
  });

  it('drops fields it does not know, so a number or a summary can never ride along', () => {
    const parsed = QueueActivity.parse({
      ...activity,
      tickets: [{ ...activity.tickets[1], callerNumber: '+919800000000', summary: 'a charge' }],
    });
    expect(parsed.tickets[0]).not.toHaveProperty('callerNumber');
    expect(parsed.tickets[0]).not.toHaveProperty('summary');
  });
});

describe('RoutingChange and PoolConsideration', () => {
  it('accepts a change with and without values, and rejects an unknown area or op', () => {
    accepts(RoutingChange, {
      area: 'node',
      op: 'added',
      key: 'node a',
      path: ['nodes', 0],
      summary: 'Node a added',
    });
    accepts(RoutingChange, {
      area: 'branch',
      op: 'changed',
      key: 'k',
      path: [],
      summary: 's',
      before: 1,
      after: { a: 2 },
    });
    rejects(RoutingChange, { area: 'colour', op: 'added', key: 'k', path: [], summary: 's' });
    rejects(RoutingChange, { area: 'node', op: 'moved', key: 'k', path: [], summary: 's' });
    rejects(RoutingChange, { area: 'node', op: 'added', key: 'k', path: [{}], summary: 's' });
  });

  it('rejects a pool consideration with an unknown reason or result', () => {
    const member = {
      memberId: 'a',
      agentId: 'a',
      releaseId: POINT_ID,
      priority: 50,
      enabled: true,
      open: null,
      productOk: true,
      skillsOk: true,
      languageOk: true,
      eligible: true,
      tier: 0,
      active: 0,
      capacity: null,
      full: false,
      picked: true,
      reasons: [],
    };
    const base = {
      poolId: POOL_SALES,
      poolName: 'Sales',
      turn: null,
      node: null,
      wanted: { language: 'en', languageMode: 'caller', products: null, skills: [] },
      languageUsed: 'en',
      members: [member],
      result: 'picked',
    };
    accepts(PoolConsideration, base);
    rejects(PoolConsideration, { ...base, result: 'shrugged' });
    rejects(PoolConsideration, { ...base, members: [{ ...member, reasons: ['sulking'] }] });
  });
});
