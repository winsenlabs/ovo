import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PublishPreview,
  RoutingEvalRun,
  RoutingPointSummary,
  RoutingSimulationResult,
  RoutingStats,
  RoutingUtilisation,
  PoolUtilisation,
} from '@winsendotai/ovo-contracts';
import { PostgresCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { createOperationsRuntime, type OperationsRuntime } from '../src/operations-runtime.ts';
import { registerOperationsRoutes } from '../src/routes/operations.ts';
import { registerRoutingRoutes } from '../src/routes/routing.ts';
import { draftInput, exampleReleases, fakeStore, poolInput, registry } from './routing-fixtures.ts';
import { scriptedSimulator } from './routing-sim-fixtures.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('routing console endpoints on the operations database (R4)', () => {
  const organizationId = `routing-r4-${randomUUID()}`;
  const number = `+9181${String(Date.now()).slice(-8)}`;
  let runtime: OperationsRuntime;
  let outcomes: PostgresCallOutcomeStore;
  let app: FastifyInstance;
  const simulator = scriptedSimulator();
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
    runtime = await createOperationsRuntime({ organizationId, databaseUrl, routingEnabled: true });
    outcomes = await PostgresCallOutcomeStore.open({ connectionString: databaseUrl! });
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
      transferEnabled: false,
      requireCostPolicy: false,
      registry,
      expectedVersion: (request) => Number(String(request.headers['if-match']).replaceAll('"', '')),
      outcomes: { available: true, open: async () => outcomes },
      simulator,
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
    await outcomes?.close();
    await runtime?.close();
  });

  it('seeds pools and a published point, and reads the overview in one query each', async () => {
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
    const draft = draftInput();
    draft.nodes[0].branches[0].target.poolId = ids.sales;
    draft.nodes[0].branches[1].target.poolId = ids.support;
    ids.point = (await call('POST', '/v1/routing/points', { draft })).json().id;
    const preview = PublishPreview.parse(
      (await call('POST', `/v1/routing/points/${ids.point}/preview-publish`, {})).json(),
    );
    expect(preview).toMatchObject({
      canPublish: true,
      nextVersion: 1,
      previous: null,
      unchanged: false,
    });
    const first = await call('POST', `/v1/routing/points/${ids.point}/releases`, {});
    expect(first.statusCode, first.body).toBe(201);
    ids.release = first.json().id;
    // The preview told the truth: the same digest, then nothing to publish.
    expect(first.json().digest).toBe(preview.digest);
    const again = PublishPreview.parse(
      (await call('POST', `/v1/routing/points/${ids.point}/preview-publish`, {})).json(),
    );
    expect(again).toMatchObject({ unchanged: true, nextVersion: 2, changes: [] });
    expect(again.previous).toMatchObject({ id: ids.release, version: 1 });

    const bound = await call('PUT', `/v1/operations/inbound/routes/${encodeURIComponent(number)}`, {
      expectedVersion: null,
      routingReleaseId: ids.release,
    });
    expect(bound.statusCode, bound.body).toBe(200);
    const listed = (await call('GET', '/v1/routing/points?include=summary')).json();
    expect(RoutingPointSummary.parse(listed.items[0].summary)).toMatchObject({
      nodes: 1,
      pools: 2,
      latestRelease: { id: ids.release, version: 1 },
      published: true,
      numbers: 1,
    });
    const releases = (
      await call('GET', `/v1/routing/points/${ids.point}/releases?view=summary`)
    ).json();
    expect(releases.items).toMatchObject([{ id: ids.release, version: 1, numbers: 1 }]);
    expect(releases.items[0]).not.toHaveProperty('snapshot');
  });

  it('counts real claims in the utilisation endpoints and passes them to a live-load simulation', async () => {
    const member = (memberId: string) => ({
      poolId: ids.sales!,
      memberId,
      agentId: memberId,
      releaseId: ids.release!,
      capacity: 3,
    });
    for (const [callId, memberId] of [
      ['c1', 'sales-en'],
      ['c2', 'sales-en'],
      ['c3', 'sales-hi'],
    ] as const)
      await runtime.service.routing.claims.claim({
        callId: `${organizationId}-${callId}`,
        routingReleaseId: ids.release!,
        ttlSeconds: 300,
        tiers: [[member(memberId)]],
      });
    const overview = RoutingUtilisation.parse(
      (await call('GET', '/v1/routing/utilisation')).json(),
    );
    expect(overview.pools.find((pool) => pool.poolId === ids.sales)).toEqual({
      poolId: ids.sales,
      active: 3,
      capacity: null,
      unlimitedMembers: 2,
    });
    const pool = PoolUtilisation.parse(
      (await call('GET', `/v1/routing/pools/${ids.sales}/utilisation`)).json(),
    );
    expect(pool.members).toMatchObject([
      { memberId: 'sales-en', active: 2 },
      { memberId: 'sales-hi', active: 1 },
    ]);

    const ran = await call('POST', '/v1/routing/simulate', {
      target: { kind: 'release', routingReleaseId: ids.release },
      turns: [{ kind: 'speech', text: 'I want to buy' }],
      load: 'live',
    });
    expect(ran.statusCode, ran.body).toBe(200);
    RoutingSimulationResult.parse(ran.json());
    expect(simulator.calls.simulate.at(-1)!.load).toEqual({
      [`${ids.sales}:sales-en`]: 2,
      [`${ids.sales}:sales-hi`]: 1,
    });
    const draftRun = await call('POST', '/v1/routing/simulate', {
      target: { kind: 'draft', pointId: ids.point },
    });
    expect(draftRun.json().source).toMatchObject({
      kind: 'draft',
      digest: expect.any(String),
    });

    const explained = await call('POST', '/v1/routing/pools/explain', {
      poolId: ids.sales,
      load: 'live',
      context: { language: 'hi' },
    });
    expect(explained.statusCode, explained.body).toBe(200);
    expect(simulator.calls.explain.at(-1)!.load).toEqual({ 'sales-en': 2, 'sales-hi': 1 });
  });

  it('stores, lists, reads and deletes an eval run on the real table', async () => {
    const body = {
      routingReleaseId: ids.release,
      name: 'Worked example',
      cases: [
        { id: 'sales-1', turns: [{ kind: 'speech', text: 'buy' }], expect: { status: 'agent' } },
        { id: 'fallback-1', expect: { fallback: 'default' } },
      ],
    };
    const created = await call('POST', '/v1/routing/eval-runs', body);
    expect(created.statusCode, created.body).toBe(201);
    const run = RoutingEvalRun.parse(created.json());
    expect(run).toMatchObject({ caseCount: 2, routingPointId: ids.point, releaseVersion: 1 });
    const listed = (await call('GET', '/v1/routing/eval-runs')).json();
    expect(listed.items.map((item: { id: string }) => item.id)).toEqual([run.id]);
    expect(listed.items[0]).not.toHaveProperty('scorecard');
    expect(
      (await call('GET', `/v1/routing/eval-runs/${run.id}`)).json().scorecard.totals.cases,
    ).toBe(2);
    const missing = await call('POST', '/v1/routing/eval-runs', {
      ...body,
      routingReleaseId: randomUUID(),
    });
    expect(missing.statusCode).toBe(404);
    expect((await call('DELETE', `/v1/routing/eval-runs/${run.id}`)).statusCode).toBe(204);
    expect((await call('GET', '/v1/routing/eval-runs')).json().items).toEqual([]);
  });

  it('folds stats from the PostgreSQL call outcomes of this workspace only', async () => {
    const at = new Date().toISOString();
    const point = ids.point!;
    await outcomes.append(organizationId, `${organizationId}-routed`, [
      {
        id: 'r0',
        at,
        type: 'route.segment',
        payload: {
          index: 0,
          role: 'router',
          agentId: 'front-desk',
          releaseId: ids.release,
          reason: 'start',
        },
      },
      {
        id: 'r1',
        at,
        type: 'route.decision',
        payload: {
          routingPointId: point,
          routingReleaseId: ids.release,
          path: ['intent'],
          target: 'agent',
          poolId: ids.sales,
          memberId: 'sales-hi',
          turns: 3,
          routeMs: 2000,
        },
      },
    ]);
    await outcomes.append(`${organizationId}-other`, 'foreign', [
      {
        id: 'f1',
        at,
        type: 'route.decision',
        payload: {
          routingPointId: point,
          routingReleaseId: ids.release,
          path: [],
          target: 'end',
          turns: 1,
          routeMs: 10,
        },
      },
    ]);
    const stats = RoutingStats.parse((await call('GET', '/v1/routing/stats?window=24h')).json());
    expect(stats.available).toBe(true);
    expect(stats.totals).toMatchObject({
      routed: 1,
      byTarget: { agent: 1, end: 0 },
      avgTurns: 3,
      routeMsP50: 2000,
    });
    expect(stats.points).toEqual([{ pointId: point, routed: 1, withFallback: 0, human: 0 }]);
    expect(stats.pools).toEqual([{ poolId: ids.sales, picks: 1, byMember: { 'sales-hi': 1 } }]);
    const onePoint = RoutingStats.parse(
      (await call('GET', `/v1/routing/stats?pointId=${randomUUID()}`)).json(),
    );
    expect(onePoint.totals.routed).toBe(0);
  });
});
