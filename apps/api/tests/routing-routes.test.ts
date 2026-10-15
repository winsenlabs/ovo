import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RoutingPoolDefinition } from '@winsendotai/ovo-contracts';
import {
  DEFAULT_RELEASE,
  draftInput,
  POOL_SALES,
  POOL_SUPPORT,
  poolInput,
  ROUTER_RELEASE,
  routingApp,
} from './routing-fixtures.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup(options: Parameters<typeof routingApp>[0] = {}) {
  const built = routingApp(options);
  apps.push(built.app);
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => built.app.inject({ method, url, payload: payload as never, headers });
  return { ...built, call };
}

/** The two pools of the worked example, created with fixed ids so the draft can name them. */
async function seedPools(routing: ReturnType<typeof routingApp>['routing']) {
  const definition = (name: string, members: [string, string[]][]) =>
    RoutingPoolDefinition.parse(poolInput(name, members));
  await routing.pools.create(
    definition('Sales', [
      ['sales-en', ['en']],
      ['sales-hi', ['hi']],
    ]),
    POOL_SALES,
  );
  await routing.pools.create(definition('Support', [['support', ['en']]]), POOL_SUPPORT);
}

describe('routing status and the dark switch (A1)', () => {
  it('reports every flag to a viewer', async () => {
    const { call } = setup({ externalEnabled: true });
    const status = await call('GET', '/v1/routing/status', undefined, { 'x-role': 'viewer' });
    expect(status.json()).toEqual({ enabled: true, externalEnabled: true, transferEnabled: false });
    const transfer = setup({ transferEnabled: true });
    expect((await transfer.call('GET', '/v1/routing/status')).json().transferEnabled).toBe(true);
  });

  it('answers 404 routing_disabled on every other route while routing is off', async () => {
    const { call } = setup({ enabled: false });
    expect((await call('GET', '/v1/routing/status')).json()).toEqual({
      enabled: false,
      externalEnabled: false,
      transferEnabled: false,
    });
    const id = '99999999-9999-4999-8999-999999999999';
    const routes: [Parameters<typeof call>[0], string][] = [
      ['GET', '/v1/routing/pools'],
      ['POST', '/v1/routing/pools'],
      ['GET', `/v1/routing/pools/${id}`],
      ['PUT', `/v1/routing/pools/${id}`],
      ['DELETE', `/v1/routing/pools/${id}`],
      ['GET', '/v1/routing/points'],
      ['POST', '/v1/routing/points'],
      ['GET', `/v1/routing/points/${id}`],
      ['PUT', `/v1/routing/points/${id}`],
      ['DELETE', `/v1/routing/points/${id}`],
      ['POST', `/v1/routing/points/${id}/validate`],
      ['POST', `/v1/routing/points/${id}/releases`],
      ['GET', `/v1/routing/points/${id}/releases`],
      ['GET', `/v1/routing/releases/${id}`],
      ['GET', '/v1/routing/audio'],
      ['POST', '/v1/routing/audio?name=Music'],
      ['GET', `/v1/routing/audio/${id}`],
      ['GET', `/v1/routing/audio/${id}/content`],
      ['DELETE', `/v1/routing/audio/${id}`],
    ];
    for (const [method, url] of routes) {
      const response = await call(method, url, {}, { 'if-match': '"1"' });
      expect([method, url, response.statusCode, response.json().error.code]).toEqual([
        method,
        url,
        404,
        'routing_disabled',
      ]);
    }
  });

  it('is off without the operations database even when the flag is on', async () => {
    const { call } = setup({ operations: undefined });
    expect((await call('GET', '/v1/routing/status')).json().enabled).toBe(false);
    expect((await call('GET', '/v1/routing/pools')).statusCode).toBe(503);
  });
});

describe('pools (A2)', () => {
  it('creates, reads with usedBy, updates and deletes with etags and audit', async () => {
    const { call, store } = setup();
    const created = await call('POST', '/v1/routing/pools', {
      definition: poolInput('Sales', [['sales-en', ['en']]]),
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const pool = created.json();
    expect(pool.definition.members[0]).toMatchObject({ priority: 50, enabled: true });

    const read = await call('GET', `/v1/routing/pools/${pool.id}`, undefined, {
      'x-role': 'viewer',
    });
    expect(read.json()).toMatchObject({ id: pool.id, usedBy: [] });
    expect(
      (await call('GET', '/v1/routing/pools', undefined, { 'x-role': 'viewer' })).json(),
    ).toMatchObject({ items: [{ id: pool.id }], nextCursor: null });

    const definition = poolInput('Sales', [['sales-en', ['en', 'hi']]]);
    expect((await call('PUT', `/v1/routing/pools/${pool.id}`, { definition })).statusCode).toBe(
      428,
    );
    const stale = await call(
      'PUT',
      `/v1/routing/pools/${pool.id}`,
      { definition },
      { 'if-match': '"9"' },
    );
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: 'routing_pool_conflict' },
      current: { version: 1 },
    });
    const updated = await call(
      'PUT',
      `/v1/routing/pools/${pool.id}`,
      { definition },
      { 'if-match': '"1"' },
    );
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.headers.etag).toBe('"2"');

    expect(
      (
        await call('DELETE', `/v1/routing/pools/${pool.id}`, undefined, { 'if-match': '"1"' })
      ).json().error.code,
    ).toBe('routing_pool_conflict');
    expect(
      (await call('DELETE', `/v1/routing/pools/${pool.id}`, undefined, { 'if-match': '"2"' }))
        .statusCode,
    ).toBe(204);
    expect((await call('GET', `/v1/routing/pools/${pool.id}`)).json().error.code).toBe(
      'routing_pool_not_found',
    );
    expect(store.audits.map((entry) => [entry.action, entry.resourceType])).toEqual([
      ['routing.pool.create', 'routing_pool'],
      ['routing.pool.update', 'routing_pool'],
      ['routing.pool.delete', 'routing_pool'],
    ]);
  });

  it('keeps viewers to reads', async () => {
    const { call } = setup();
    const viewer = { 'x-role': 'viewer' };
    const body = { definition: poolInput('Sales', [['sales-en', ['en']]]) };
    expect((await call('POST', '/v1/routing/pools', body, viewer)).statusCode).toBe(403);
    expect((await call('GET', '/v1/routing/pools', undefined, viewer)).statusCode).toBe(200);
  });

  it('refuses an invalid definition (422) and a taken name (409)', async () => {
    const { call } = setup();
    const invalid = await call('POST', '/v1/routing/pools', {
      definition: { name: 'Sales', members: [] },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('routing_pool_invalid');
    const body = { definition: poolInput('Sales', [['sales-en', ['en']]]) };
    expect((await call('POST', '/v1/routing/pools', body)).statusCode).toBe(201);
    const again = await call('POST', '/v1/routing/pools', {
      definition: poolInput('sales', [['sales-hi', ['hi']]]),
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('routing_pool_name_taken');
  });

  it('refuses to delete a pool a point draft names, listing the points', async () => {
    const { call, routing } = setup();
    await seedPools(routing);
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    expect((await call('GET', `/v1/routing/pools/${POOL_SALES}`)).json().usedBy).toEqual([
      point.id,
    ]);
    const refused = await call('DELETE', `/v1/routing/pools/${POOL_SALES}`, undefined, {
      'if-match': '"1"',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: 'routing_pool_in_use' },
      usedBy: [point.id],
    });
  });
});

describe('points (A3)', () => {
  it('stores a draft free of structural errors, with draftVersion etags', async () => {
    const { call, store } = setup();
    const created = await call('POST', '/v1/routing/points', { draft: draftInput() });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const point = created.json();
    expect(point).toMatchObject({ draftVersion: 1, issues: [] });
    expect(point.draft.limits).toEqual({ maxTurns: 6, maxRouteSeconds: 90 });

    const draft = { ...draftInput(), name: 'Main line v2' };
    const stale = await call(
      'PUT',
      `/v1/routing/points/${point.id}`,
      { draft },
      { 'if-match': '"3"' },
    );
    expect(stale.json()).toMatchObject({
      error: { code: 'routing_point_conflict' },
      current: { draftVersion: 1 },
    });
    const updated = await call(
      'PUT',
      `/v1/routing/points/${point.id}`,
      { draft },
      { 'if-match': '"1"' },
    );
    expect(updated.headers.etag).toBe('"2"');
    const read = await call('GET', `/v1/routing/points/${point.id}`, undefined, {
      'x-role': 'viewer',
    });
    expect([read.headers.etag, read.json().draft.name]).toEqual(['"2"', 'Main line v2']);
    expect(store.audits.map((entry) => entry.action)).toEqual([
      'routing.point.create',
      'routing.point.update',
    ]);
  });

  it('refuses a draft with structural errors as 422 issues, and keeps warnings', async () => {
    const { call, routing } = setup();
    const broken = draftInput();
    broken.root = 'missing';
    const refused = await call('POST', '/v1/routing/points', { draft: broken });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().issues.map((issue: { code: string }) => issue.code)).toContain(
      'routing_root_missing',
    );
    expect(await routing.points.list(10)).toEqual([]);
    const schema = await call('POST', '/v1/routing/points', { draft: { name: 'x' } });
    expect([schema.statusCode, schema.json().error.code]).toEqual([422, 'routing_draft_invalid']);

    const warned = draftInput();
    warned.nodes[0].fallback.splice(2, 0, { kind: 'human', queueId: 'desk' });
    const kept = await call('POST', '/v1/routing/points', { draft: warned });
    expect(kept.statusCode).toBe(201);
    expect(kept.json().issues).toEqual([
      expect.objectContaining({ code: 'routing_human_unavailable', severity: 'warning' }),
    ]);
  });

  it('validates the stored or a given draft without writing anything', async () => {
    const { call, routing } = setup();
    await seedPools(routing);
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const stored = await call('POST', `/v1/routing/points/${point.id}/validate`, {});
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json().issues).toEqual([]);
    const given = { ...draftInput(), router: { agentId: 'nobody', release: { kind: 'latest' } } };
    const checked = await call('POST', `/v1/routing/points/${point.id}/validate`, { draft: given });
    expect(checked.json().issues.map((issue: { code: string }) => issue.code)).toEqual([
      'routing_router_missing',
    ]);
    expect((await routing.points.get(point.id))!.draft.router.agentId).toBe('front-desk');
    expect(
      (await call('POST', `/v1/routing/points/${point.id}/validate`, {}, { 'x-role': 'viewer' }))
        .statusCode,
    ).toBe(403);
  });

  it('refuses to delete a point numbers are pinned to, naming them masked', async () => {
    const { call, routing } = setup();
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    routing.pinned.set(point.id, ['+918040001234']);
    const refused = await call('DELETE', `/v1/routing/points/${point.id}`, undefined, {
      'if-match': '"1"',
    });
    expect(refused.json()).toEqual({
      error: {
        code: 'routing_point_in_use',
        message: 'Inbound numbers are pinned to releases of this routing point',
      },
      numbers: ['••••1234'],
    });
    routing.pinned.clear();
    expect(
      (await call('DELETE', `/v1/routing/points/${point.id}`, undefined, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(204);
  });
});

describe('releases (A4, A5)', () => {
  it('publishes versioned releases, lists them newest first and reads one', async () => {
    const { call, routing, store } = setup();
    await seedPools(routing);
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const first = await call('POST', `/v1/routing/points/${point.id}/releases`, {
      expectedDraftVersion: 1,
    });
    expect(first.statusCode, first.body).toBe(201);
    const release = first.json();
    expect(release).toMatchObject({ version: 1, draftVersion: 1, routingPointId: point.id });
    expect(release.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(release.snapshot.router.release).toEqual({ kind: 'pinned', releaseId: ROUTER_RELEASE });
    expect(release.snapshot.defaultTarget.release.releaseId).toBe(DEFAULT_RELEASE);
    expect(store.audits.at(-1)).toMatchObject({
      action: 'routing.release.create',
      resourceType: 'routing_release',
      resourceId: release.id,
      payload: {
        pointId: point.id,
        version: 1,
        digest: release.digest,
        routerReleaseId: ROUTER_RELEASE,
        defaultReleaseId: DEFAULT_RELEASE,
        memberCount: 3,
      },
    });
    const second = (await call('POST', `/v1/routing/points/${point.id}/releases`, {})).json();
    expect(second.version).toBe(2);
    // Nothing changed, so the canonical snapshot and its digest are the same.
    expect(second.digest).toBe(release.digest);

    const listed = await call('GET', `/v1/routing/points/${point.id}/releases`, undefined, {
      'x-role': 'viewer',
    });
    expect(listed.json().items.map((item: { version: number }) => item.version)).toEqual([2, 1]);
    const read = await call('GET', `/v1/routing/releases/${release.id}`, undefined, {
      'x-role': 'viewer',
    });
    expect(read.json()).toMatchObject({ id: release.id, version: 1 });
    const missing = await call('GET', '/v1/routing/releases/99999999-9999-4999-8999-999999999999');
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_release_not_found',
    ]);
  });

  it('refuses a stale expectedDraftVersion, and a viewer', async () => {
    const { call, routing } = setup();
    await seedPools(routing);
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const stale = await call('POST', `/v1/routing/points/${point.id}/releases`, {
      expectedDraftVersion: 2,
    });
    expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'routing_point_conflict']);
    expect(
      (await call('POST', `/v1/routing/points/${point.id}/releases`, {}, { 'x-role': 'viewer' }))
        .statusCode,
    ).toBe(403);
  });

  it('answers 422 with blockers and warnings, writing nothing', async () => {
    const { call, routing } = setup();
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const blocked = await call('POST', `/v1/routing/points/${point.id}/releases`, {});
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error.code).toBe('routing_publish_blocked');
    expect(blocked.json().blockers.map((issue: { code: string }) => issue.code)).toEqual([
      'routing_pool_missing',
      'routing_pool_missing',
    ]);
    expect(await routing.releases.list(point.id, 10)).toEqual([]);
  });
});
