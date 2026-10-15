import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoutingMemberCandidate } from '@winsendotai/ovo-contracts';
import { PostgresOperationsService } from '../src/index.ts';
import { publishedRelease, releaseIds, routingSchema } from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const POOL = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';

describe.skipIf(!postgresUrl)('routing member claims', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let operations: PostgresOperationsService;
  let routingReleaseId: string;
  const ids = releaseIds();
  const member = (memberId: string, capacity?: number, poolId = POOL): RoutingMemberCandidate => ({
    poolId,
    memberId,
    agentId: memberId,
    releaseId: ids.en,
    ...(capacity === undefined ? {} : { capacity }),
  });
  const claim = (callId: string, tiers: RoutingMemberCandidate[][], ttlSeconds = 300) =>
    operations.routing.claims.claim({ callId, routingReleaseId, ttlSeconds, tiers });

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    operations = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-claims' });
    await operations.migrate();
    routingReleaseId = (await publishedRelease(operations.routing, ids)).id;
  });

  afterAll(async () => db?.drop());

  it('never overfills a member under 20 parallel claims', async () => {
    const tier = [member('cap-a', 5), member('cap-b', 3)];
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claim(`parallel-${i}`, [tier])),
    );
    const claimed = results.filter((r) => r.kind === 'claimed');
    expect(claimed).toHaveLength(8);
    expect(results.filter((r) => r.kind === 'full')).toHaveLength(12);
    expect(await operations.routing.claims.active(POOL)).toMatchObject({ 'cap-a': 5, 'cap-b': 3 });
    for (let i = 0; i < 20; i += 1) await operations.routing.claims.release(`parallel-${i}`);
    expect(await operations.routing.claims.active(POOL)).toEqual({});
  });

  it('takes the least-loaded member of the first tier with room', async () => {
    const top = [member('top-a', 2), member('top-b', 4)];
    const next = [member('next-a')];
    const picks: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const result = await claim(`tier-${i}`, [top, next]);
      picks.push(result.kind === 'claimed' ? result.candidate.memberId : result.kind);
    }
    // top-a 0/2 and top-b 0/4 tie at load 0 (member id breaks it); then lowest active/capacity.
    expect(picks).toEqual(['top-a', 'top-b', 'top-b', 'top-a', 'top-b', 'top-b', 'next-a']);
    // Unlimited members balance by active claims.
    const open = [member('open-a'), member('open-b')];
    const spread: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await claim(`open-${i}`, [open]);
      if (result.kind === 'claimed') spread.push(result.candidate.memberId);
    }
    expect(spread).toEqual(['open-a', 'open-b', 'open-a', 'open-b']);
  });

  it('is idempotent per call and moves a re-routed call to its new member', async () => {
    const first = await claim('same-call', [[member('idem-a', 1)]]);
    const again = await claim('same-call', [[member('idem-a', 1)]]);
    expect(first.kind).toBe('claimed');
    expect(again).toEqual(first);
    const moved = await claim('same-call', [[member('idem-b', 1)]]);
    expect(moved).toMatchObject({ kind: 'claimed', candidate: { memberId: 'idem-b' } });
    expect(await operations.routing.claims.active(POOL)).toMatchObject({ 'idem-b': 1 });
    expect((await operations.routing.claims.active(POOL))['idem-a']).toBeUndefined();
    expect(await operations.routing.claims.release('same-call')).toBe(1);
    expect(await operations.routing.claims.release('same-call')).toBe(0);
  });

  it('lets an expired claim lapse so a crashed call frees its member', async () => {
    const lone = [[member('lapse', 1)]];
    expect((await claim('crashed', lone)).kind).toBe('claimed');
    expect((await claim('blocked', lone)).kind).toBe('full');
    await db.pool.query(
      "UPDATE ovo_routing_member_claims SET expires_at = now() - interval '1 second' WHERE call_id = 'crashed'",
    );
    expect(await claim('after', lone)).toMatchObject({
      kind: 'claimed',
      candidate: { memberId: 'lapse' },
    });
    // The crashed call can claim again: its lapsed row is closed, not counted twice.
    expect((await claim('crashed', [[member('lapse-2', 1)]])).kind).toBe('claimed');
  });

  it('counts per (pool, member) and refuses bad input', async () => {
    const other = randomUUID();
    expect((await claim('pool-a', [[member('shared', 1)]])).kind).toBe('claimed');
    expect(await claim('pool-b', [[member('shared', 1, other)]])).toMatchObject({
      kind: 'claimed',
      candidate: { poolId: other },
    });
    expect(await claim('nobody', [])).toEqual({ kind: 'full' });
    await expect(claim('', [[member('x')]])).rejects.toThrow(/callId/);
    await expect(claim('ttl', [[member('x')]], 0)).rejects.toThrow(/ttlSeconds/);
  });
});
