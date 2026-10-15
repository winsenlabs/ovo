import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createOperationsRuntime, type OperationsRuntime } from '../src/operations-runtime.ts';
import { registerOperationsRoutes } from '../src/routes/operations.ts';
import { registerRoutingRoutes } from '../src/routes/routing.ts';
import {
  draftInput,
  exampleReleases,
  fakeStore,
  poolInput,
  registry,
  ROUTER_RELEASE,
} from './routing-fixtures.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('routing API on the operations database (A2-A6)', () => {
  // An organization of its own: pool names are unique per organization in the shared database.
  const organizationId = `routing-api-${randomUUID()}`;
  const number = `+9180${String(Date.now()).slice(-8)}`;
  let runtime: OperationsRuntime;
  let app: FastifyInstance;
  const store = fakeStore(
    exampleReleases().map((item) => ({ ...item, workspaceId: organizationId })),
  );
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) => app.inject({ method, url, payload: payload as never, headers });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    runtime = await createOperationsRuntime({
      organizationId,
      databaseUrl,
      routingEnabled: true,
    });
    app = Fastify({ logger: false });
    app.setErrorHandler((caught, _request, reply) => {
      const thrown = caught as Error & { statusCode?: number; code?: string };
      if (thrown instanceof z.ZodError)
        return reply.code(400).send({ error: { code: 'validation_error' } });
      return reply
        .code(thrown.statusCode ?? 500)
        .send({ error: { code: thrown.code ?? 'internal_error', message: thrown.message } });
    });
    const requireRole = () => ({
      identityId: 'operator',
      label: 'Operator',
      workspaceId: organizationId,
      role: 'admin' as const,
    });
    registerRoutingRoutes({
      app,
      store: store as never,
      requireRole,
      operations: runtime.service,
      enabled: true,
      externalEnabled: false,
      requireCostPolicy: false,
      registry,
      expectedVersion: (request) => Number(String(request.headers['if-match']).replaceAll('"', '')),
    });
    registerOperationsRoutes({
      app,
      store: store as never,
      requireRole,
      operations: runtime.service,
      routingEnabled: true,
    });
  });

  afterAll(async () => {
    await app?.close();
    await runtime?.service.pool.query(
      'DELETE FROM ovo_ops_inbound_routes WHERE organization_id = $1',
      [organizationId],
    );
    await runtime?.close();
  });

  it('keeps pools: unique names, optimistic versions', async () => {
    for (const [key, name, members] of [
      [
        'sales',
        'Sales',
        [
          ['sales-en', ['en']],
          ['sales-hi', ['hi']],
        ],
      ],
      ['support', 'Support', [['support', ['en']]]],
    ] as const) {
      const created = await call('POST', '/v1/routing/pools', {
        definition: poolInput(name, members as never),
      });
      expect(created.statusCode, created.body).toBe(201);
      ids[key] = created.json().id;
    }
    const taken = await call('POST', '/v1/routing/pools', {
      definition: poolInput('SALES', [['sales-en', ['en']]]),
    });
    expect([taken.statusCode, taken.json().error.code]).toEqual([409, 'routing_pool_name_taken']);
    const renamed = await call(
      'PUT',
      `/v1/routing/pools/${ids.support}`,
      { definition: poolInput('Sales', [['support', ['en']]]) },
      { 'if-match': '"1"' },
    );
    expect(renamed.json().error.code).toBe('routing_pool_name_taken');
    const stale = await call(
      'PUT',
      `/v1/routing/pools/${ids.support}`,
      { definition: poolInput('Support desk', [['support', ['en']]]) },
      { 'if-match': '"7"' },
    );
    expect(stale.json()).toMatchObject({
      error: { code: 'routing_pool_conflict' },
      current: { id: ids.support, version: 1 },
    });
  });

  it('stores a point, refuses deleting a pool it names, and publishes numbered releases', async () => {
    const draft = draftInput();
    draft.nodes[0].branches[0].target.poolId = ids.sales;
    draft.nodes[0].branches[1].target.poolId = ids.support;
    const point = await call('POST', '/v1/routing/points', { draft });
    expect(point.statusCode, point.body).toBe(201);
    ids.point = point.json().id;
    const inUse = await call('DELETE', `/v1/routing/pools/${ids.sales}`, undefined, {
      'if-match': '"1"',
    });
    expect(inUse.json()).toMatchObject({
      error: { code: 'routing_pool_in_use' },
      usedBy: [ids.point],
    });
    expect((await call('GET', `/v1/routing/pools/${ids.sales}`)).json().usedBy).toEqual([
      ids.point,
    ]);

    const validated = await call('POST', `/v1/routing/points/${ids.point}/validate`, {});
    expect(validated.json()).toEqual({ issues: [] });
    const first = await call('POST', `/v1/routing/points/${ids.point}/releases`, {
      expectedDraftVersion: 1,
    });
    expect(first.statusCode, first.body).toBe(201);
    const second = await call('POST', `/v1/routing/points/${ids.point}/releases`, {});
    expect([first.json().version, second.json().version]).toEqual([1, 2]);
    ids.release = first.json().id;
    expect(first.json().snapshot.router.release.releaseId).toBe(ROUTER_RELEASE);
    expect(Object.keys(first.json().snapshot.pools).sort()).toEqual(
      [ids.sales, ids.support].sort(),
    );

    const page = await call('GET', `/v1/routing/points/${ids.point}/releases?limit=1`);
    expect(page.json().items.map((item: { version: number }) => item.version)).toEqual([2]);
    const next = await call(
      'GET',
      `/v1/routing/points/${ids.point}/releases?limit=1&cursor=${page.json().nextCursor}`,
    );
    expect(next.json().items.map((item: { version: number }) => item.version)).toEqual([1]);
    expect((await call('GET', `/v1/routing/releases/${ids.release}`)).json().id).toBe(ids.release);
  });

  it('switches a number between a routing release and an agent release', async () => {
    const path = `/v1/operations/inbound/routes/${encodeURIComponent(number)}`;
    const routed = await call('PUT', path, {
      expectedVersion: null,
      routingReleaseId: ids.release,
    });
    expect(routed.statusCode, routed.body).toBe(200);
    expect(routed.json()).toMatchObject({ releaseId: null, routingReleaseId: ids.release });
    const pinned = await call('DELETE', `/v1/routing/points/${ids.point}`, undefined, {
      'if-match': '"1"',
    });
    expect(pinned.json()).toEqual({
      error: {
        code: 'routing_point_in_use',
        message: 'Inbound numbers are pinned to releases of this routing point',
      },
      numbers: [`••••${number.slice(-4)}`],
    });
    const direct = await call('PUT', path, { expectedVersion: 1, releaseId: ROUTER_RELEASE });
    expect(direct.json()).toMatchObject({ releaseId: ROUTER_RELEASE, routingReleaseId: null });
    expect(
      (await call('DELETE', `/v1/routing/points/${ids.point}`, undefined, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call('DELETE', `/v1/routing/pools/${ids.sales}`, undefined, { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(204);
    expect(store.audits.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'routing.pool.create',
        'routing.point.create',
        'routing.release.create',
        'operations.inbound.route.put',
        'routing.point.delete',
        'routing.pool.delete',
      ]),
    );
  });
});
