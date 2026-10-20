import { describe, expect, it } from 'vitest';
import {
  PoolSnapshot,
  RoutingPoolTarget,
  type RouteContext,
  type RoutingMemberCandidate,
} from '@winsendotai/ovo-contracts';
import { explainPool } from '../src/explain.ts';
import { eligibleTiers, pickMember, rankCandidates } from '../src/members.ts';
import { createSimClock, createSimHost, memberKey } from '../src/simulate/host.ts';
import { exampleRoutingSnapshot, EXAMPLE_IDS as I } from '../src/testing.ts';
import { NIGHT, NOON } from './support-sim.ts';

const target = (raw: Record<string, unknown>) => RoutingPoolTarget.parse({ kind: 'pool', ...raw });
const example = exampleRoutingSnapshot();
const sales = example.pools[I.salesPool]!;
const support = example.pools[I.supportPool]!;
const explain = (
  pool: PoolSnapshot,
  t: RoutingPoolTarget,
  context: RouteContext,
  over: Partial<Parameters<typeof explainPool>[0]> = {},
) => explainPool({ pool, target: t, context, defaultLanguage: 'en', now: NOON, ...over });
const byId = (result: ReturnType<typeof explainPool>) =>
  Object.fromEntries(result.members.map((member) => [member.memberId, member]));

describe('explainPool', () => {
  it('picks the member that speaks the caller language and says why the others are out', () => {
    const result = explain(sales, target({ poolId: I.salesPool }), { language: 'hi', values: {} });
    expect(result).toMatchObject({
      poolId: I.salesPool,
      poolName: 'Sales',
      languageUsed: 'hi',
      wanted: { language: 'hi', languageMode: 'caller', products: null, skills: [] },
      result: 'picked',
    });
    expect(byId(result)['sales-hi']).toMatchObject({
      eligible: true,
      picked: true,
      tier: 0,
      reasons: [],
    });
    expect(byId(result)['sales-en']).toMatchObject({
      eligible: false,
      picked: false,
      tier: null,
      languageOk: false,
      reasons: ['language'],
    });
  });

  it('reads member hours at the given time and falls back to the pool language fallback', () => {
    const ta = { language: 'ta', values: {} };
    expect(explain(sales, target({ poolId: I.salesPool }), ta).languageUsed).toBe('ta');
    const night = explain(sales, target({ poolId: I.salesPool }), ta, { now: NIGHT });
    expect(night).toMatchObject({ languageUsed: 'en', result: 'picked' });
    expect(byId(night)['sales-ta']).toMatchObject({
      open: false,
      eligible: false,
      reasons: ['closed', 'language'],
    });
    expect(byId(night)['sales-en']!.open).toBeNull();
  });

  it('reports products, skills and disabled members', () => {
    const pool = PoolSnapshot.parse({
      ...support,
      members: support.members.map((m, i) => ({
        ...m,
        enabled: i !== 1,
        skills: i === 0 ? ['vip'] : [],
      })),
    });
    const result = explain(
      pool,
      target({
        poolId: I.supportPool,
        products: { values: ['loans'] },
        skills: ['vip'],
        language: 'any',
      }),
      { values: {} },
    );
    const members = byId(result);
    expect(result).toMatchObject({
      result: 'no_eligible_member',
      wanted: { products: ['loans'], skills: ['vip'], language: null, languageMode: 'any' },
    });
    expect(members['support-cards']).toMatchObject({
      productOk: false,
      skillsOk: true,
      reasons: ['product'],
    });
    expect(members['support-hi']).toMatchObject({
      enabled: false,
      productOk: true,
      skillsOk: false,
      reasons: ['disabled', 'skill'],
    });
    expect(members['support-loans']).toMatchObject({
      productOk: true,
      skillsOk: false,
      reasons: ['skill'],
    });
  });

  it('treats a product the router never learned as no constraint', () => {
    const result = explain(
      support,
      target({ poolId: I.supportPool, products: { context: 'product' }, language: 'any' }),
      { values: {} },
    );
    expect(result.wanted.products).toBeNull();
    expect(result.members.every((m) => m.productOk)).toBe(true);
  });

  it('orders priority tiers highest first and picks the least loaded member of the first tier with room', () => {
    const any = target({ poolId: I.supportPool, language: 'any' });
    const idle = explain(support, any, { values: {} });
    expect(byId(idle)['support-cards']).toMatchObject({ tier: 0, picked: true, priority: 60 });
    expect(byId(idle)['support-hi']!.tier).toBe(1);
    const capped = PoolSnapshot.parse({
      ...support,
      members: support.members.map((m) => (m.id === 'support-cards' ? { ...m, capacity: 1 } : m)),
    });
    const full = explain(
      capped,
      any,
      { values: {} },
      { load: { 'support-cards': 1, 'support-hi': 2 } },
    );
    expect(byId(full)['support-cards']).toMatchObject({
      full: true,
      active: 1,
      capacity: 1,
      reasons: ['full'],
    });
    expect(byId(full)['support-loans']!.picked).toBe(true);
    expect(byId(full)['support-hi']!.picked).toBe(false);
    expect(full.result).toBe('picked');
  });

  it('says pool_full, or queued when the point waits for capacity, once every eligible member is full', () => {
    const t = target({ poolId: I.salesPool });
    const fullMembers = new Set(['sales-en']);
    expect(explain(sales, t, { values: {} }, { fullMembers }).result).toBe('pool_full');
    expect(explain(sales, t, { values: {} }, { fullMembers, waitForCapacity: true }).result).toBe(
      'queued',
    );
    expect(byId(explain(sales, t, { values: {} }, { fullMembers }))['sales-en']).toMatchObject({
      full: true,
      reasons: ['fault'],
    });
  });
});

/** mulberry32: a small seeded generator, so the property test is the same on every machine. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('explainPool agrees with eligibleTiers', () => {
  const LANGUAGES = ['en', 'hi', 'ta', 'bn'];
  const TAGS = ['cards', 'loans', 'vip'];
  const NOWS = [NOON, NIGHT, Date.UTC(2026, 9, 18, 6, 30)];

  it('on 3000 generated pools, targets and contexts', async () => {
    const next = random(18);
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const subset = <T>(items: readonly T[], max = items.length) =>
      items.filter(() => next() < 0.4).slice(0, max);
    for (let round = 0; round < 3000; round += 1) {
      const pool = PoolSnapshot.parse({
        id: I.salesPool,
        version: 1,
        name: 'Generated',
        languageFallback: subset(LANGUAGES, 2),
        members: Array.from({ length: 1 + Math.floor(next() * 6) }, (_, index) => {
          const spoken = subset(LANGUAGES);
          return {
            id: `m${index}`,
            agent: { agentId: `agent-${index}`, release: { kind: 'pinned', releaseId: I.salesEn } },
            languages: spoken.length ? spoken : ['en'],
            products: subset(TAGS),
            skills: subset(TAGS),
            priority: pick([10, 50, 50, 90]),
            enabled: next() < 0.85,
            ...(next() < 0.3 ? { capacity: 1 + Math.floor(next() * 3) } : {}),
            ...(next() < 0.4
              ? {
                  hours: {
                    timezone: 'Asia/Kolkata',
                    weekly: pick([
                      {},
                      { thu: [{ start: '09:00', end: '18:00' }] },
                      Object.fromEntries(
                        ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [
                          d,
                          [{ start: '00:00', end: '24:00' }],
                        ]),
                      ),
                    ]),
                  },
                }
              : {}),
          };
        }),
      });
      const wanted = target({
        poolId: I.salesPool,
        language: pick(['caller', 'caller', 'any']),
        skills: subset(TAGS, 2),
        ...(next() < 0.5
          ? { products: pick([{ context: 'product' }, { values: [pick(TAGS)] }]) }
          : {}),
      });
      const context: RouteContext = {
        ...(next() < 0.7 ? { language: pick(LANGUAGES) } : {}),
        values: next() < 0.6 ? { product: pick(TAGS) } : {},
      };
      const now = pick(NOWS);
      const input = { pool, target: wanted, context, defaultLanguage: 'en', now };
      const tiers = eligibleTiers(input);
      const load = Object.fromEntries(pool.members.map((m) => [m.id, Math.floor(next() * 4)]));
      const result = explainPool({ ...input, load });
      const grouped = new Map<number, string[]>();
      for (const member of result.members)
        if (member.eligible)
          grouped.set(member.tier!, [...(grouped.get(member.tier!) ?? []), member.memberId]);
      expect([...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids)).toEqual(
        tiers.map((tier) => tier.map((candidate) => candidate.memberId)),
      );
      expect(result.members.every((m) => (m.tier === null) === !m.eligible)).toBe(true);
      expect(result.result === 'no_eligible_member').toBe(tiers.length === 0);
      // The host claims whom the explanation picked, with the same load.
      const host = createSimHost({
        clock: createSimClock(now),
        call: {
          callId: 'c',
          workspaceId: 'w',
          routingPointId: I.routingPoint,
          routingReleaseId: I.routingPoint,
          variables: {},
        },
        load: Object.fromEntries(
          Object.entries(load).map(([id, n]) => [memberKey(pool.id, id), n]),
        ),
        full: new Set(),
      });
      const claimed = await pickMember({
        pools: { [pool.id]: pool },
        target: wanted,
        context,
        defaultLanguage: 'en',
        host,
        signal: new AbortController().signal,
      });
      const picked = result.members.find((m) => m.picked)?.memberId;
      expect(claimed.kind === 'claimed' ? claimed.candidate.memberId : undefined).toBe(picked);
    }
  });
});

describe('rankCandidates', () => {
  const candidate = (memberId: string, capacity?: number): RoutingMemberCandidate => ({
    poolId: I.salesPool,
    memberId,
    agentId: memberId,
    releaseId: I.salesEn,
    ...(capacity ? { capacity } : {}),
  });
  const rank = (tier: RoutingMemberCandidate[], active: Record<string, number>) =>
    rankCandidates(tier, (c) => active[c.memberId] ?? 0).map((c) => c.memberId);

  it('prefers the lower utilisation, then fewer active calls, then the member id', () => {
    const tier = [candidate('c', 4), candidate('a', 2), candidate('b'), candidate('d')];
    expect(rank(tier, { c: 2, a: 1, b: 9, d: 3 })).toEqual(
      ['d', 'b', 'a', 'c'].filter((id) => id !== 'x'),
    );
    expect(rank([candidate('b'), candidate('a')], {})).toEqual(['a', 'b']);
  });

  it('drops members at capacity', () => {
    expect(rank([candidate('a', 1), candidate('b', 2)], { a: 1, b: 1 })).toEqual(['b']);
  });
});
