import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoutingMemberCandidate } from '@winsendotai/ovo-contracts';
import { PostgresOperationsService } from '../src/index.ts';
import { publishedRelease, releaseIds, routingSchema } from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
const POOL_A = '9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a';
const POOL_B = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';
const POOL_C = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';

describe.skipIf(!postgresUrl)('routing utilisation reads', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let operations: PostgresOperationsService;
  let other: PostgresOperationsService;
  let routingReleaseId: string;
  const ids = releaseIds();
  const member = (poolId: string, memberId: string): RoutingMemberCandidate => ({
    poolId,
    memberId,
    agentId: memberId,
    releaseId: ids.en,
  });
  const claim = (
    service: PostgresOperationsService,
    callId: string,
    candidate: RoutingMemberCandidate,
    ttlSeconds = 300,
  ) => service.routing.claims.claim({ callId, routingReleaseId, ttlSeconds, tiers: [[candidate]] });

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    operations = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-util' });
    other = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-util-other' });
    await operations.migrate();
    routingReleaseId = (await publishedRelease(operations.routing, ids)).id;
  });

  afterAll(async () => db?.drop());

  describe('claims.activeByPool', () => {
    it('counts active claims per pool and member in one query', async () => {
      await claim(operations, 'a1', member(POOL_A, 'one'));
      await claim(operations, 'a2', member(POOL_A, 'one'));
      await claim(operations, 'a3', member(POOL_A, 'two'));
      await claim(operations, 'b1', member(POOL_B, 'one'));
      expect(await operations.routing.claims.activeByPool([POOL_A, POOL_B, POOL_C])).toEqual({
        [POOL_A]: { one: 2, two: 1 },
        [POOL_B]: { one: 1 },
        [POOL_C]: {},
      });
      // The single-pool read agrees.
      expect(await operations.routing.claims.active(POOL_A)).toEqual({ one: 2, two: 1 });
    });

    it('drops a released claim and an expired one', async () => {
      await operations.routing.claims.release('a1');
      await db.pool.query(
        `UPDATE ovo_routing_member_claims SET expires_at = now() - interval '1 second'
         WHERE organization_id = 'org-util' AND call_id = 'b1'`,
      );
      expect(await operations.routing.claims.activeByPool([POOL_A, POOL_B])).toEqual({
        [POOL_A]: { one: 1, two: 1 },
        [POOL_B]: {},
      });
    });

    it('is scoped to the organization and tolerates empty and invalid ids', async () => {
      expect(await other.routing.claims.activeByPool([POOL_A])).toEqual({ [POOL_A]: {} });
      expect(await operations.routing.claims.activeByPool([])).toEqual({});
      expect(await operations.routing.claims.activeByPool(['nope', POOL_A, POOL_A])).toEqual({
        [POOL_A]: { one: 1, two: 1 },
      });
    });
  });

  describe('releases.latest', () => {
    it('returns the newest release of each point and skips points without one', async () => {
      const first = await publishedRelease(operations.routing, releaseIds(), 'Latest A');
      const second = await publishedRelease(operations.routing, releaseIds(), 'Latest B');
      const point = await operations.routing.points.get(first.routingPointId);
      // A second release of the first point: version 2 wins.
      const next = await operations.routing.releases.create({
        pointId: first.routingPointId,
        draftVersion: point!.draftVersion,
        snapshot: first.snapshot,
        digest: first.digest,
        createdBy: 'user:tester',
      });
      const draftOnly = await operations.routing.points.create(point!.draft);
      const latest = await operations.routing.releases.latest([
        first.routingPointId,
        second.routingPointId,
        draftOnly.id,
        randomUUID(),
        'nope',
      ]);
      expect([...latest.keys()].sort()).toEqual(
        [first.routingPointId, second.routingPointId].sort(),
      );
      expect(latest.get(first.routingPointId)).toEqual({
        id: next!.id,
        version: 2,
        digest: first.digest,
        draftVersion: point!.draftVersion,
        createdAt: next!.createdAt,
      });
      expect(latest.get(second.routingPointId)).toMatchObject({ id: second.id, version: 1 });
      expect(latest.get(second.routingPointId)).not.toHaveProperty('snapshot');
    });

    it('is scoped to the organization and tolerates empty input', async () => {
      const release = await publishedRelease(operations.routing, releaseIds(), 'Scoped');
      expect((await other.routing.releases.latest([release.routingPointId])).size).toBe(0);
      expect((await operations.routing.releases.latest([])).size).toBe(0);
    });
  });
});
