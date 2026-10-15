import { describe, expect, it } from 'vitest';
import { RoutingTarget, type RouteContext } from '@winsendotai/ovo-contracts';
import { eligibleTiers, pickMember } from '../src/members.ts';
import { exampleRoutingSnapshot, EXAMPLE_IDS as I, fakeRoutingHost } from '../src/testing.ts';

// 06:30 UTC on Thursday 2026-10-15 is noon in Kolkata: the Tamil agent's office is open.
const NOON = Date.UTC(2026, 9, 15, 6, 30);
const NIGHT = Date.UTC(2026, 9, 15, 17, 0);

function snapshot(patch?: (raw: Record<string, any>) => void) {
  return exampleRoutingSnapshot(patch);
}
const pool = (raw: Record<string, unknown>) =>
  RoutingTarget.parse({ kind: 'pool', ...raw }) as Extract<RoutingTarget, { kind: 'pool' }>;
const ids = (tiers: { memberId: string }[][]) => tiers.map((tier) => tier.map((m) => m.memberId));

function tiers(
  target: ReturnType<typeof pool>,
  context: RouteContext,
  now = NOON,
  patch?: (raw: Record<string, any>) => void,
) {
  const routing = snapshot(patch);
  return eligibleTiers({
    pool: routing.pools[target.poolId]!,
    target,
    context,
    defaultLanguage: 'en',
    now,
  });
}

describe('eligibleTiers', () => {
  const sales = pool({ poolId: I.salesPool });
  const support = pool({ poolId: I.supportPool, products: { context: 'product' } });

  it.each<[string, ReturnType<typeof pool>, RouteContext, number, string[][]]>([
    ['the caller language', sales, { language: 'hi', values: {} }, NOON, [['sales-hi']]],
    ['the default language before one is known', sales, { values: {} }, NOON, [['sales-en']]],
    ['open hours', sales, { language: 'ta', values: {} }, NOON, [['sales-ta']]],
    [
      'closed hours fall to the pool languageFallback',
      sales,
      { language: 'ta', values: {} },
      NIGHT,
      [['sales-en']],
    ],
    [
      'a language nobody speaks falls back too',
      sales,
      { language: 'bn', values: {} },
      NOON,
      [['sales-en']],
    ],
    [
      'any language, grouped by priority',
      pool({ poolId: I.supportPool, language: 'any' }),
      { values: {} },
      NOON,
      [['support-cards'], ['support-hi', 'support-loans']],
    ],
    [
      'the product from context',
      support,
      { values: { product: 'loans' } },
      NOON,
      [['support-loans']],
    ],
    [
      'the product and the language',
      support,
      { language: 'hi', values: { product: 'loans' } },
      NOON,
      [['support-hi']],
    ],
    [
      'no product known: every product',
      pool({ poolId: I.supportPool, language: 'any', products: { context: 'product' } }),
      { values: {} },
      NOON,
      [['support-cards'], ['support-hi', 'support-loans']],
    ],
    [
      'a fixed product list',
      pool({ poolId: I.supportPool, language: 'any', products: { values: ['cards'] } }),
      { values: {} },
      NOON,
      [['support-cards'], ['support-hi']],
    ],
  ])('%s', (_name, target, context, now, expected) => {
    expect(ids(tiers(target, context, now))).toEqual(expected);
  });

  it('needs every skill and skips disabled members', () => {
    const patch = (raw: Record<string, any>) => {
      const members = raw.pools[I.supportPool].members;
      members[0].skills = ['vip', 'retention'];
      members[1].skills = ['vip'];
      members[2].enabled = false;
    };
    const target = pool({ poolId: I.supportPool, language: 'any', skills: ['vip'] });
    expect(ids(tiers(target, { values: {} }, NOON, patch))).toEqual([
      ['support-cards'],
      ['support-hi'],
    ]);
    const both = pool({ poolId: I.supportPool, language: 'any', skills: ['vip', 'retention'] });
    expect(ids(tiers(both, { values: {} }, NOON, patch))).toEqual([['support-cards']]);
  });

  it('carries each candidate release and capacity', () => {
    const patch = (raw: Record<string, any>) => (raw.pools[I.salesPool].members[1].capacity = 20);
    expect(tiers(sales, { language: 'hi', values: {} }, NOON, patch)).toEqual([
      [
        {
          poolId: I.salesPool,
          memberId: 'sales-hi',
          agentId: 'sales-hi',
          releaseId: I.salesHi,
          capacity: 20,
        },
      ],
    ]);
  });
});

describe('pickMember', () => {
  const sales = pool({ poolId: I.salesPool });
  const pick = (
    host: ReturnType<typeof fakeRoutingHost>,
    target = sales,
    context: RouteContext = { values: {} },
  ) =>
    pickMember({
      pools: snapshot().pools,
      target,
      context,
      defaultLanguage: 'en',
      host,
      signal: new AbortController().signal,
    });

  it('claims through the host with the tiers in priority order', async () => {
    const host = fakeRoutingHost({ start: NOON });
    const picked = await pick(host);
    expect(picked).toMatchObject({ kind: 'claimed', candidate: { memberId: 'sales-en' } });
    expect(host.claims).toHaveLength(1);
  });

  it('fails pool_full when the host has no room', async () => {
    const host = fakeRoutingHost({ start: NOON, claim: () => ({ kind: 'full' }) });
    await expect(pick(host)).resolves.toEqual({ kind: 'failed', reason: 'pool_full' });
  });

  it('fails no_eligible_member without asking the host', async () => {
    const host = fakeRoutingHost({ start: NOON });
    const nobody = pool({ poolId: I.salesPool, skills: ['astrophysics'] });
    await expect(pick(host, nobody)).resolves.toEqual({
      kind: 'failed',
      reason: 'no_eligible_member',
    });
    expect(host.claims).toHaveLength(0);
  });

  it('fails pool_missing for a pool the release does not hold', async () => {
    const host = fakeRoutingHost({ start: NOON });
    const unknown = pool({ poolId: '00000000-0000-4000-8000-0000000000ff' });
    await expect(pick(host, unknown)).resolves.toEqual({ kind: 'failed', reason: 'pool_missing' });
  });

  it('proceeds unclaimed when claim storage is unavailable or the host throws (fail-open)', async () => {
    const unavailable = fakeRoutingHost({
      start: NOON,
      claim: (t) => ({ kind: 'unclaimed', candidate: t[0]![0]!, reason: 'claims_unavailable' }),
    });
    await expect(pick(unavailable)).resolves.toMatchObject({
      kind: 'unclaimed',
      reason: 'claims_unavailable',
    });
    const throwing = fakeRoutingHost({
      start: NOON,
      claim: () => {
        throw new Error('db down');
      },
    });
    await expect(pick(throwing)).resolves.toMatchObject({
      kind: 'unclaimed',
      candidate: { memberId: 'sales-en' },
      reason: 'claims_unavailable',
    });
  });
});
