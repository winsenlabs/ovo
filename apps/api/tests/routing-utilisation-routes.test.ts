import { describe, expect, it } from 'vitest';
import {
  PoolConsideration,
  PoolUtilisation,
  RoutingPoolDefinition,
  RoutingStats,
  RoutingUtilisation,
} from '@winsendotai/ovo-contracts';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { POOL_SALES, POOL_SUPPORT, SALES_HI_RELEASE, poolInput } from './routing-fixtures.ts';
import { r4Setup, scriptedSimulator } from './routing-sim-fixtures.ts';

const viewer = { 'x-role': 'viewer' };
const NOW = Date.parse('2026-10-20T10:00:00.000Z');

/** Sales has a capped English member, a capped Hindi member that opens only on weekdays, and an unbounded one. */
async function withCapacity(routing: Awaited<ReturnType<typeof r4Setup>>['routing']) {
  const sales = (await routing.pools.get(POOL_SALES))!;
  await routing.pools.update(
    POOL_SALES,
    RoutingPoolDefinition.parse({
      ...sales.definition,
      members: [
        { ...sales.definition.members[0], capacity: 4 },
        {
          ...sales.definition.members[1],
          capacity: 2,
          hours: {
            timezone: 'UTC',
            weekly: {
              mon: [{ start: '09:00', end: '17:00' }],
              tue: [{ start: '09:00', end: '17:00' }],
            },
            closed: [],
          },
        },
        {
          id: 'sales-open',
          agent: { agentId: 'sales-open', release: { kind: 'latest' } },
          languages: ['en'],
        },
      ],
    }),
    1,
  );
  routing.activeClaims[POOL_SALES] = { 'sales-en': 3, 'sales-hi': 1, 'sales-open': 2 };
}

describe('GET /v1/routing/utilisation and /pools/:id/utilisation (R4)', () => {
  it('reports every pool: active claims against the capacity of its enabled members', async () => {
    const { call, routing } = await r4Setup({ clock: () => NOW });
    await withCapacity(routing);
    const response = await call('GET', '/v1/routing/utilisation', undefined, viewer);
    expect(response.statusCode, response.body).toBe(200);
    const body = RoutingUtilisation.parse(response.json());
    expect(body.at).toBe('2026-10-20T10:00:00.000Z');
    expect(body.pools).toEqual([
      { poolId: POOL_SALES, active: 6, capacity: 6, unlimitedMembers: 1 },
      { poolId: POOL_SUPPORT, active: 0, capacity: null, unlimitedMembers: 1 },
    ]);
  });

  it('counts only enabled members toward capacity', async () => {
    const { call, routing } = await r4Setup();
    const sales = (await routing.pools.get(POOL_SALES))!;
    await routing.pools.update(
      POOL_SALES,
      RoutingPoolDefinition.parse({
        ...sales.definition,
        members: sales.definition.members.map((member) => ({
          ...member,
          capacity: 5,
          enabled: member.id === 'sales-en',
        })),
      }),
      1,
    );
    const body = (await call('GET', '/v1/routing/utilisation', undefined, viewer)).json();
    expect(body.pools[0]).toMatchObject({ poolId: POOL_SALES, capacity: 5, unlimitedMembers: 0 });
  });

  it('reports a pool member by member, with hours read at the server clock', async () => {
    const { call, routing } = await r4Setup({ clock: () => NOW });
    await withCapacity(routing);
    const response = await call(
      'GET',
      `/v1/routing/pools/${POOL_SALES}/utilisation`,
      undefined,
      viewer,
    );
    expect(response.statusCode, response.body).toBe(200);
    // 2026-10-20 is a Tuesday, 10:00 UTC: inside the Hindi member's hours.
    expect(PoolUtilisation.parse(response.json())).toEqual({
      poolId: POOL_SALES,
      at: '2026-10-20T10:00:00.000Z',
      members: [
        { memberId: 'sales-en', active: 3, capacity: 4, enabled: true, open: null },
        { memberId: 'sales-hi', active: 1, capacity: 2, enabled: true, open: true },
        { memberId: 'sales-open', active: 2, capacity: null, enabled: true, open: null },
      ],
      total: { active: 6, capacity: 6 },
    });
    const closed = routing_at('2026-10-24T10:00:00.000Z');
    const night = await r4Setup({ clock: () => closed });
    await withCapacity(night.routing);
    const saturday = await night.call(
      'GET',
      `/v1/routing/pools/${POOL_SALES}/utilisation`,
      undefined,
      viewer,
    );
    expect(saturday.json().members[1].open).toBe(false);
  });

  it('404s an unknown pool, validates the id and reads the dark switch', async () => {
    const { call } = await r4Setup();
    const missing = await call(
      'GET',
      `/v1/routing/pools/${SALES_HI_RELEASE}/utilisation`,
      undefined,
      viewer,
    );
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_pool_not_found',
    ]);
    expect(
      (await call('GET', '/v1/routing/pools/not-a-uuid/utilisation', undefined, viewer)).statusCode,
    ).toBe(400);
    const dark = await r4Setup({ enabled: false });
    expect((await dark.call('GET', '/v1/routing/utilisation')).json().error.code).toBe(
      'routing_disabled',
    );
  });
});

const routing_at = (iso: string) => Date.parse(iso);

describe('POST /v1/routing/pools/explain (R4)', () => {
  it('explains a stored pool for a caller language, through the router', async () => {
    const simulator = scriptedSimulator();
    const { call, routing } = await r4Setup({ simulator, clock: () => NOW });
    routing.activeClaims[POOL_SALES] = { 'sales-hi': 1 };
    const response = await call(
      'POST',
      '/v1/routing/pools/explain',
      {
        poolId: POOL_SALES,
        target: { language: 'caller', skills: ['senior'] },
        context: { language: 'hi', values: { product: 'cards' } },
        load: 'live',
        fullMembers: ['sales-en'],
      },
      viewer,
    );
    expect(response.statusCode, response.body).toBe(200);
    const explained = PoolConsideration.parse(response.json());
    expect(explained).toMatchObject({
      poolId: POOL_SALES,
      poolName: 'Sales',
      turn: null,
      node: null,
    });
    expect(simulator.calls.explain).toHaveLength(1);
    const asked = simulator.calls.explain[0]!;
    expect(asked).toMatchObject({
      defaultLanguage: 'en',
      now: NOW,
      load: { 'sales-hi': 1 },
      waitForCapacity: false,
      target: { kind: 'pool', poolId: POOL_SALES, language: 'caller', skills: ['senior'] },
      context: { language: 'hi', values: { product: 'cards' } },
    });
    expect([...asked.fullMembers!]).toEqual(['sales-en']);
    expect(asked.pool.members.map((member) => member.id)).toEqual(['sales-en', 'sales-hi']);
    // A member's agent has no published release in this fixture's store for sales-en/sales-hi: the
    // explanation names the latest one, or the placeholder when there is none.
    for (const member of asked.pool.members) expect(member.agent.release.kind).toBe('pinned');
  });

  it('accepts the target as the console sends it (with kind and poolId) and a product in the context', async () => {
    const simulator = scriptedSimulator();
    const { call } = await r4Setup({ simulator });
    const response = await call(
      'POST',
      '/v1/routing/pools/explain',
      {
        poolId: POOL_SALES,
        target: {
          kind: 'pool',
          poolId: POOL_SALES,
          language: 'any',
          products: { values: ['cards'] },
          skills: [],
        },
        context: { language: 'en', product: 'cards' },
        load: 'empty',
      },
      viewer,
    );
    expect(response.statusCode, response.body).toBe(200);
    const asked = simulator.calls.explain[0]!;
    expect(asked.target).toEqual({
      kind: 'pool',
      poolId: POOL_SALES,
      language: 'any',
      skills: [],
      products: { values: ['cards'] },
    });
    expect(asked.context).toEqual({ language: 'en', values: { product: 'cards' } });
    const mismatched = await call(
      'POST',
      '/v1/routing/pools/explain',
      { poolId: POOL_SALES, target: { poolId: POOL_SUPPORT } },
      viewer,
    );
    expect([mismatched.statusCode, mismatched.json().error.code]).toEqual([
      422,
      'routing_explain_invalid',
    ]);
  });

  it('explains an unsaved definition without load, at a given time', async () => {
    const simulator = scriptedSimulator();
    const { call } = await r4Setup({ simulator });
    const definition = poolInput('Draft pool', [['support', ['en']]]);
    const at = '2026-10-21T08:30:00.000Z';
    const response = await call(
      'POST',
      '/v1/routing/pools/explain',
      { definition, at, load: 'live' },
      viewer,
    );
    expect(response.statusCode, response.body).toBe(200);
    const asked = simulator.calls.explain[0]!;
    expect(asked.now).toBe(Date.parse(at));
    expect(asked.load).toBeUndefined();
    expect(asked.pool.name).toBe('Draft pool');
    expect(asked.target).toMatchObject({ language: 'caller', skills: [] });
  });

  it('refuses a bad body (422), an unknown pool (404), and answers 503 without a router', async () => {
    const { call } = await r4Setup({ simulator: scriptedSimulator() });
    for (const body of [
      {},
      { poolId: POOL_SALES, definition: poolInput('x', [['a', ['en']]]) },
      { poolId: 'nope' },
      { poolId: POOL_SALES, target: { language: 'klingon' } },
      { poolId: POOL_SALES, context: { language: 'english' } },
      { poolId: POOL_SALES, fullMembers: ['BAD'] },
      { poolId: POOL_SALES, extra: 1 },
    ]) {
      const refused = await call('POST', '/v1/routing/pools/explain', body, viewer);
      expect([refused.statusCode, refused.json().error.code], JSON.stringify(body)).toEqual([
        422,
        'routing_explain_invalid',
      ]);
    }
    const missing = await call(
      'POST',
      '/v1/routing/pools/explain',
      { poolId: SALES_HI_RELEASE },
      viewer,
    );
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_pool_not_found',
    ]);
    const bare = await r4Setup();
    const unavailable = await bare.call(
      'POST',
      '/v1/routing/pools/explain',
      { poolId: POOL_SALES },
      viewer,
    );
    expect([unavailable.statusCode, unavailable.json().error.code]).toEqual([
      503,
      'routing_simulator_unavailable',
    ]);
  });
});

const at = '2026-10-20T09:00:00.000Z';
const routedEvents = (id: string) =>
  [
    [
      'route.segment',
      {
        index: 0,
        role: 'router',
        agentId: 'front-desk',
        releaseId: SALES_HI_RELEASE,
        reason: 'start',
      },
    ],
    [
      'route.decision',
      {
        routingPointId: POOL_SALES,
        routingReleaseId: POOL_SUPPORT,
        path: ['intent'],
        target: 'agent',
        poolId: POOL_SALES,
        memberId: id,
        turns: 2,
        routeMs: 1_500,
      },
    ],
  ] as const;

describe('GET /v1/routing/stats (R4)', () => {
  async function seeded() {
    const outcomes = new MemoryCallOutcomeStore();
    for (const [index, member] of ['sales-en', 'sales-hi', 'sales-en'].entries())
      await outcomes.append(
        'ws-routing',
        `call-${index}`,
        routedEvents(member).map(([type, payload], i) => ({
          id: `${index}-${i}`,
          at,
          type,
          payload: payload as never,
        })),
      );
    return { available: true, open: async () => outcomes } as never;
  }

  it('folds the window from the call outcomes and echoes the window and bucket', async () => {
    const { call } = await r4Setup({ outcomes: await seeded(), clock: () => NOW });
    const response = await call('GET', '/v1/routing/stats?window=24h', undefined, viewer);
    expect(response.statusCode, response.body).toBe(200);
    const stats = RoutingStats.parse(response.json());
    expect(stats).toMatchObject({
      available: true,
      window: '24h',
      bucket: 'hour',
      since: '2026-10-19T10:00:00.000Z',
      until: '2026-10-20T10:00:00.000Z',
      totals: { routed: 3, byTarget: { agent: 3 }, avgTurns: 2, routeMsP50: 1_500 },
      points: [{ pointId: POOL_SALES, routed: 3 }],
      pools: [{ poolId: POOL_SALES, picks: 3, byMember: { 'sales-en': 2, 'sales-hi': 1 } }],
    });
    expect(stats.series).toHaveLength(24);
    expect(stats.series.find((row) => row.at === '2026-10-20T09:00:00.000Z')).toMatchObject({
      routed: 3,
      agent: 3,
    });
  });

  it('defaults to 24 hours, buckets longer windows by day and filters by point', async () => {
    const { call } = await r4Setup({ outcomes: await seeded(), clock: () => NOW });
    const week = RoutingStats.parse(
      (await call('GET', '/v1/routing/stats?window=7d', undefined, viewer)).json(),
    );
    expect(week).toMatchObject({ window: '7d', bucket: 'day' });
    expect(week.series).toHaveLength(8);
    expect(
      RoutingStats.parse((await call('GET', '/v1/routing/stats', undefined, viewer)).json()).window,
    ).toBe('24h');
    const month = RoutingStats.parse(
      (await call('GET', '/v1/routing/stats?window=30d', undefined, viewer)).json(),
    );
    expect(month.bucket).toBe('day');
    const other = RoutingStats.parse(
      (
        await call('GET', `/v1/routing/stats?pointId=${SALES_HI_RELEASE}`, undefined, viewer)
      ).json(),
    );
    expect(other.totals.routed).toBe(0);
  });

  it('says not available without an outcomes store, rather than reporting zeros as fact', async () => {
    const { call } = await r4Setup({ clock: () => NOW });
    const stats = RoutingStats.parse(
      (await call('GET', '/v1/routing/stats', undefined, viewer)).json(),
    );
    expect(stats).toMatchObject({ available: false, window: '24h', series: [], points: [] });
    const sqlite = await r4Setup({
      outcomes: { available: false, open: async () => Promise.reject(new Error('no')) },
    });
    expect(
      RoutingStats.parse((await sqlite.call('GET', '/v1/routing/stats', undefined, viewer)).json())
        .available,
    ).toBe(false);
  });

  it('rejects an unknown window, a bad point id and unknown keys with 422', async () => {
    const { call } = await r4Setup({ outcomes: await seeded() });
    for (const query of ['window=1y', 'pointId=nope', 'window=24h&extra=1']) {
      const refused = await call('GET', `/v1/routing/stats?${query}`, undefined, viewer);
      expect([refused.statusCode, refused.json().error.code], query).toEqual([
        422,
        'routing_stats_invalid',
      ]);
    }
  });
});
