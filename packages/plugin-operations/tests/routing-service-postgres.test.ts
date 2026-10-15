import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresOperationsService,
  RoutingPoolNameTakenError,
  routingSnapshotDigest,
} from '../src/index.ts';
import {
  publishedRelease,
  releaseIds,
  routingSchema,
  salesDraft,
  salesPool,
  salesSnapshot,
} from './routing-fixture.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('routing storage (pools, points, releases)', () => {
  let db: Awaited<ReturnType<typeof routingSchema>>;
  let operations: PostgresOperationsService;
  const ids = releaseIds();

  beforeAll(async () => {
    db = await routingSchema(postgresUrl!);
    operations = new PostgresOperationsService({
      pool: db.pool,
      organizationId: 'org-routing',
      config: { permittedFromNumbers: [], routingEnabled: true },
    });
    await operations.migrate();
  });

  afterAll(async () => db?.drop());

  it('reports the routing flag, off by default', () => {
    expect(operations.config.routingEnabled).toBe(true);
    expect(operations.routing.enabled).toBe(true);
    const off = new PostgresOperationsService({ pool: db.pool, organizationId: 'org-routing' });
    expect([off.config.routingEnabled, off.routing.enabled]).toEqual([false, false]);
  });

  it('versions pools, refuses stale writes and duplicate names, and soft-deletes', async () => {
    const routing = operations.routing;
    const created = await routing.pools.create(salesPool(ids, 'Cards'));
    expect(created).toMatchObject({ workspaceId: 'org-routing', version: 1 });
    expect(created.definition.members[0]).toMatchObject({ priority: 50, enabled: true });
    await expect(routing.pools.create(salesPool(ids, 'CARDS'))).rejects.toBeInstanceOf(
      RoutingPoolNameTakenError,
    );
    const renamed = await routing.pools.update(created.id, salesPool(ids, 'Cards 2'), 1);
    expect(renamed).toMatchObject({ version: 2, definition: { name: 'Cards 2' } });
    expect(await routing.pools.update(created.id, salesPool(ids, 'Cards 3'), 1)).toBeUndefined();
    expect(await routing.pools.get(created.id)).toEqual(renamed);
    expect(await routing.pools.remove(created.id, 1)).toBe('conflict');
    expect(await routing.pools.remove(created.id, 2)).toBe('removed');
    expect(await routing.pools.get(created.id)).toBeUndefined();
    expect(await routing.pools.remove(created.id, 2)).toBe('conflict');
    // The name is free again once the pool is deleted.
    expect(await routing.pools.create(salesPool(ids, 'Cards 2'))).toMatchObject({ version: 1 });
    expect(await routing.pools.get('not-a-uuid')).toBeUndefined();
  });

  it('pages pools and points by id', async () => {
    const routing = operations.routing;
    for (const n of [1, 2, 3]) await routing.pools.create(salesPool(ids, `Page ${n}`));
    const all = await routing.pools.list(100);
    const first = await routing.pools.list(2);
    const second = await routing.pools.list(2, first.at(-1)!.id);
    expect(first.map((p) => p.id)).toEqual(all.slice(0, 2).map((p) => p.id));
    expect(second.map((p) => p.id)).toEqual(all.slice(2, 4).map((p) => p.id));
    expect(all.map((p) => p.id)).toEqual([...all.map((p) => p.id)].sort());
  });

  it('versions point drafts, guards pools a live draft names, and refuses pinned points', async () => {
    const routing = operations.routing;
    const pool = await routing.pools.create(salesPool(ids, 'Guarded'));
    const point = await routing.points.create(salesDraft(pool.id, 'Guarded line'));
    expect(point).toMatchObject({ draftVersion: 1, draft: { name: 'Guarded line' } });
    expect(await routing.pools.remove(pool.id, 1)).toEqual({ inUseBy: [point.id] });
    const moved = await routing.points.update(point.id, salesDraft(pool.id, 'Moved'), 1);
    expect(moved).toMatchObject({ draftVersion: 2 });
    expect(await routing.points.update(point.id, salesDraft(pool.id), 1)).toBeUndefined();
    const snapshot = salesSnapshot(point.id, pool.id, ids, moved!.draft);
    const release = await routing.releases.create({
      pointId: point.id,
      draftVersion: 2,
      snapshot,
      digest: routingSnapshotDigest(snapshot),
      createdBy: 'user:a',
    });
    await operations.inboundRoutes.put({
      phoneNumber: '+14155550123',
      routingReleaseId: release!.id,
      expectedVersion: null,
    });
    expect(await routing.points.remove(point.id, 2)).toEqual({ pinnedBy: ['••••0123'] });
    await operations.inboundRoutes.remove('+14155550123', 1);
    expect(await routing.points.remove(point.id, 1)).toBe('conflict');
    expect(await routing.points.remove(point.id, 2)).toBe('removed');
    expect(await routing.points.get(point.id)).toBeUndefined();
    // The deleted point's draft no longer holds the pool; its release is kept for call history.
    expect(await routing.pools.remove(pool.id, 1)).toBe('removed');
    expect(await routing.releases.get(release!.id)).toMatchObject({ version: 1 });
  });

  it('numbers releases 1..10 under 10 concurrent publishes and lists them newest first', async () => {
    const routing = operations.routing;
    const pool = await routing.pools.create(salesPool(ids, 'Concurrent'));
    const point = await routing.points.create(salesDraft(pool.id, 'Concurrent line'));
    const snapshot = salesSnapshot(point.id, pool.id, ids);
    const digest = routingSnapshotDigest(snapshot);
    const releases = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        routing.releases.create({
          pointId: point.id,
          draftVersion: 1,
          snapshot,
          digest,
          createdBy: `user:${i}`,
        }),
      ),
    );
    expect(releases.map((r) => r!.version).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const page = await routing.releases.list(point.id, 4);
    expect(page.map((r) => r.version)).toEqual([10, 9, 8, 7]);
    const next = await routing.releases.list(point.id, 4, page.at(-1)!.id);
    expect(next.map((r) => r.version)).toEqual([6, 5, 4, 3]);
    expect(releases[0]).toMatchObject({ draftVersion: 1, digest, routingPointId: point.id });
  });

  it('refuses a publish of a moved draft, a foreign snapshot or a wrong digest', async () => {
    const routing = operations.routing;
    const pool = await routing.pools.create(salesPool(ids, 'Refusals'));
    const point = await routing.points.create(salesDraft(pool.id, 'Refusals line'));
    const snapshot = salesSnapshot(point.id, pool.id, ids);
    const input = { pointId: point.id, draftVersion: 1, snapshot, createdBy: 'user:a' };
    const digest = routingSnapshotDigest(snapshot);
    expect(await routing.releases.create({ ...input, draftVersion: 2, digest })).toBeUndefined();
    await expect(routing.releases.create({ ...input, digest: '0'.repeat(64) })).rejects.toThrow(
      /digest/,
    );
    const other = salesSnapshot(randomUUID(), pool.id, ids);
    await expect(
      routing.releases.create({ ...input, snapshot: other, digest: routingSnapshotDigest(other) }),
    ).rejects.toThrow(/different point/);
    const ghost = randomUUID();
    const lost = salesSnapshot(ghost, pool.id, ids);
    expect(
      await routing.releases.create({
        ...input,
        pointId: ghost,
        snapshot: lost,
        digest: routingSnapshotDigest(lost),
      }),
    ).toBeUndefined();
  });

  it('switches a number between a direct agent and a routing release in one write', async () => {
    const release = await publishedRelease(operations.routing, ids);
    const point = await operations.routing.points.get(release.routingPointId);
    const phoneNumber = '+14155550188';
    const direct = await operations.inboundRoutes.put({
      phoneNumber,
      releaseId: ids.fallback,
      expectedVersion: null,
    });
    expect(direct).toMatchObject({
      releaseId: ids.fallback,
      routingReleaseId: null,
      routing: null,
    });
    const routed = await operations.inboundRoutes.put({
      phoneNumber,
      routingReleaseId: release.id,
      expectedVersion: 1,
    });
    expect(routed).toMatchObject({
      version: 2,
      releaseId: null,
      routingReleaseId: release.id,
      routing: { pointId: release.routingPointId, pointName: point!.draft.name, version: 1 },
    });
    expect(
      (await operations.inboundRoutes.list(100)).find((r) => r.phoneNumber === phoneNumber),
    ).toEqual(routed);
    expect(
      await operations.inboundRoutes.put({ phoneNumber, releaseId: ids.en, expectedVersion: 2 }),
    ).toMatchObject({ releaseId: ids.en, routingReleaseId: null, routing: null });
    await expect(
      operations.inboundRoutes.put({
        phoneNumber,
        routingReleaseId: randomUUID(),
        expectedVersion: 3,
      }),
    ).rejects.toMatchObject({ constraint: 'ovo_ops_inbound_routes_routing_fk' });
    await expect(
      operations.inboundRoutes.put({ phoneNumber, expectedVersion: 3 } as never),
    ).rejects.toThrow(/exactly one/);
  });
});
