import { describe, expect, it, vi } from 'vitest';
import {
  RoutingSimulationResult,
  SIMULATION_LIMITS,
  type SimulationRequest,
} from '@winsendotai/ovo-contracts';
import {
  POOL_SALES,
  ROUTER_RELEASE,
  SALES_HI_RELEASE,
  draftInput,
  exampleReleases,
  release,
} from './routing-fixtures.ts';
import { r4Setup, scriptedSimulator } from './routing-sim-fixtures.ts';
import { NOW, editor, published, speech } from './routing-simulate-support.ts';

describe('POST /v1/routing/simulate: a published release (R4)', () => {
  it('runs a scripted caller through the release and answers the contract shape', async () => {
    const { run, release: made, simulator, point } = await published();
    const ok = await run({
      target: { kind: 'release', routingReleaseId: made.id },
      call: { from: '+919812345678', variables: { account: '7' } },
      turns: [speech('mujhe naya card chahiye'), { kind: 'dtmf', digits: '1' }],
      engines: { answers: [{ node: 'intent', engine: 'llm', branch: 'sales', confidence: 0.9 }] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const body = RoutingSimulationResult.parse(ok.json());
    expect(body.schema).toBe('ovo.route-simulation/1');
    expect(body.source).toEqual({
      kind: 'release',
      pointId: point.id,
      routingReleaseId: made.id,
      version: 1,
      digest: made.digest,
    });
    expect(body.turns.map((turn) => turn.input.kind)).toEqual(['opening', 'speech', 'dtmf']);
    expect(body.warnings).toEqual([]);
    expect(body.engineModes).toEqual({
      rules: 'real',
      decision: 'mock',
      llm: 'mock',
      external: 'mock',
    });

    const asked = simulator.calls.simulate[0]!;
    expect(asked.snapshot.routingPointId).toBe(point.id);
    expect(asked.routingReleaseId).toBe(made.id);
    expect(asked.now).toBe(NOW);
    expect(asked.flags).toEqual({ transferEnabled: false, humanQueueEnabled: false });
    expect(asked.load).toBeUndefined();
    expect(asked.live).toBeUndefined();
    expect(asked.router.timezone).toBe('Asia/Kolkata');
    expect(asked.request.call).toEqual({ from: '+919812345678', variables: { account: '7' } });
    expect(asked.request.engines.answers).toHaveLength(1);
    expect(asked.signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the router release for its timezone and disclosure', async () => {
    const releases = exampleReleases();
    releases[0] = release(ROUTER_RELEASE, 'front-desk', {
      config: {
        timezone: 'Asia/Dubai',
        compliance: { disclosures: { ai: { text: 'This call is handled by an AI assistant.' } } },
      } as never,
    });
    const { run, release: made, simulator } = await published({ releases });
    await run({ target: { kind: 'release', routingReleaseId: made.id } });
    expect(simulator.calls.simulate[0]!.router).toEqual({
      timezone: 'Asia/Dubai',
      disclosure: [{ kind: 'ai', text: 'This call is handled by an AI assistant.' }],
    });
  });

  it('starts the clock at call.at when the request gives one', async () => {
    const { run, release: made, simulator } = await published();
    const at = '2026-03-01T04:30:00.000Z';
    await run({ target: { kind: 'release', routingReleaseId: made.id }, call: { at } });
    expect(simulator.calls.simulate[0]!.now).toBe(Date.parse(at));
  });

  it('assumes what the request says and warns where it differs from the server', async () => {
    const { run, release: made, simulator } = await published({ transferEnabled: true });
    const same = RoutingSimulationResult.parse(
      (
        await run({
          target: { kind: 'release', routingReleaseId: made.id },
          assume: { transferEnabled: true },
        })
      ).json(),
    );
    expect(same.warnings).toEqual([]);
    const differs = RoutingSimulationResult.parse(
      (
        await run({
          target: { kind: 'release', routingReleaseId: made.id },
          assume: { transferEnabled: false, humanQueueEnabled: true },
        })
      ).json(),
    );
    expect(simulator.calls.simulate[1]!.flags).toEqual({
      transferEnabled: false,
      humanQueueEnabled: true,
    });
    expect(differs.assumed).toEqual({ transferEnabled: false, humanQueueEnabled: true });
    expect(differs.warnings.map((warning) => [warning.code, warning.message])).toEqual([
      ['assumption_differs', 'This run assumed transferEnabled false; the server has it true.'],
      ['assumption_differs', 'This run assumed humanQueueEnabled true; the server has it false.'],
    ]);
  });

  it('passes the live claim load as poolId:memberId, or warns when it cannot be read', async () => {
    const { run, release: made, simulator, routing } = await published();
    routing.activeClaims[POOL_SALES] = { 'sales-en': 2, 'sales-hi': 1 };
    const live = RoutingSimulationResult.parse(
      (await run({ target: { kind: 'release', routingReleaseId: made.id }, load: 'live' })).json(),
    );
    expect(live.warnings).toEqual([]);
    expect(simulator.calls.simulate[0]!.load).toEqual({
      [`${POOL_SALES}:sales-en`]: 2,
      [`${POOL_SALES}:sales-hi`]: 1,
    });
    routing.claims.activeByPool = vi.fn(async () => Promise.reject(new Error('claims down')));
    const down = RoutingSimulationResult.parse(
      (await run({ target: { kind: 'release', routingReleaseId: made.id }, load: 'live' })).json(),
    );
    expect(down.warnings.map((warning) => warning.code)).toEqual(['load_unavailable']);
    expect(simulator.calls.simulate[1]!.load).toBeUndefined();
    await run({ target: { kind: 'release', routingReleaseId: made.id } });
    expect(simulator.calls.simulate[2]!.load).toBeUndefined();
  });

  it('404s an unknown release and answers 503 where the router cannot simulate', async () => {
    const { run } = await published();
    const missing = await run({ target: { kind: 'release', routingReleaseId: SALES_HI_RELEASE } });
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_release_not_found',
    ]);
    const bare = await r4Setup();
    const unavailable = await bare.call('POST', '/v1/routing/simulate', {
      target: { kind: 'release', routingReleaseId: SALES_HI_RELEASE },
    });
    expect([unavailable.statusCode, unavailable.json().error.code]).toEqual([
      503,
      'routing_simulator_unavailable',
    ]);
  });
});

describe('POST /v1/routing/simulate: a draft (R4)', () => {
  it('resolves the stored draft like publish, marks it unpublished and carries the digest publish stores', async () => {
    const simulator = scriptedSimulator();
    const { call } = await r4Setup({ simulator, clock: () => NOW });
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const response = await call('POST', '/v1/routing/simulate', {
      target: { kind: 'draft', pointId: point.id },
      turns: [speech('sales')],
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = RoutingSimulationResult.parse(response.json());
    expect(body.source).toMatchObject({
      kind: 'draft',
      pointId: point.id,
      routingReleaseId: null,
      version: null,
    });
    expect(body.warnings.map((warning) => warning.code)).toEqual(['draft_unpublished']);
    const asked = simulator.calls.simulate[0]!;
    expect(asked.routingReleaseId).toBeUndefined();
    expect(asked.snapshot.defaultTarget.release.kind).toBe('pinned');
    const published = (await call('POST', `/v1/routing/points/${point.id}/releases`, {})).json();
    expect(published.digest).toBe(body.source.digest);
  });

  it('runs an unsaved editor draft instead of the stored one', async () => {
    const simulator = scriptedSimulator();
    const { call } = await r4Setup({ simulator });
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const carried = { ...draftInput(), name: 'Unsaved' };
    const response = await call('POST', '/v1/routing/simulate', {
      target: { kind: 'draft', pointId: point.id, draft: carried },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(simulator.calls.simulate[0]!.snapshot.name).toBe('Unsaved');
    const stored = await call('GET', `/v1/routing/points/${point.id}`, undefined, {
      'x-role': 'viewer',
    });
    expect(stored.json().draft.name).toBe('Main line');
  });

  it('refuses a draft with blockers (422) and lists them, and an unknown point (404)', async () => {
    const simulator = scriptedSimulator();
    const { call } = await r4Setup({ simulator });
    const point = (await call('POST', '/v1/routing/points', { draft: draftInput() })).json();
    const broken = { ...draftInput(), router: { agentId: 'nobody', release: { kind: 'latest' } } };
    const refused = await call('POST', '/v1/routing/simulate', {
      target: { kind: 'draft', pointId: point.id, draft: broken },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: { code: 'routing_simulate_blocked' },
      blockers: [{ code: 'routing_router_missing', severity: 'error' }],
    });
    expect(simulator.calls.simulate).toEqual([]);
    const missing = await call('POST', '/v1/routing/simulate', {
      target: { kind: 'draft', pointId: SALES_HI_RELEASE },
    });
    expect([missing.statusCode, missing.json().error.code]).toEqual([
      404,
      'routing_point_not_found',
    ]);
  });
});

describe('POST /v1/routing/simulate: roles, limits and audit (R4)', () => {
  const invalid: [string, (id: string) => unknown][] = [
    ['no target', () => ({})],
    ['a bad release id', () => ({ target: { kind: 'release', routingReleaseId: 'nope' } })],
    [
      'too many turns',
      (id) => ({
        target: { kind: 'release', routingReleaseId: id },
        turns: Array.from({ length: SIMULATION_LIMITS.turns + 1 }, () => ({ kind: 'silence' })),
      }),
    ],
    [
      'a bad caller number',
      (id) => ({ target: { kind: 'release', routingReleaseId: id }, call: { from: '12345' } }),
    ],
    [
      'an unknown field',
      (id) => ({ target: { kind: 'release', routingReleaseId: id }, surprise: true }),
    ],
    [
      'a turn with empty words',
      (id) => ({
        target: { kind: 'release', routingReleaseId: id },
        turns: [{ kind: 'speech', text: ' ' }],
      }),
    ],
  ];

  it.each(invalid)('refuses %s with 422 and the zod issues', async (_name, body) => {
    const { run, release: made, simulator } = await published();
    const response = await run(body(made.id));
    expect([response.statusCode, response.json().error.code]).toEqual([
      422,
      'routing_simulate_invalid',
    ]);
    expect(response.json().issues.length).toBeGreaterThan(0);
    expect(simulator.calls.simulate).toEqual([]);
  });

  it('lets an editor simulate and keeps a viewer out', async () => {
    const { run, release: made } = await published();
    const body = { target: { kind: 'release', routingReleaseId: made.id } };
    expect((await run(body, editor)).statusCode).toBe(200);
    expect((await run(body, { 'x-role': 'viewer' })).statusCode).toBe(403);
  });

  it('limits an identity to the configured simulations a minute and says when to retry', async () => {
    let clock = NOW;
    const { run, release: made } = await published({
      simulateRatePerMinute: 2,
      clock: () => clock,
    });
    const body = { target: { kind: 'release', routingReleaseId: made.id } };
    expect((await run(body)).statusCode).toBe(200);
    expect((await run(body)).statusCode).toBe(200);
    const limited = await run(body);
    expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    clock += 61_000;
    expect((await run(body)).statusCode).toBe(200);
  });

  it('refuses a body over 64 KiB', async () => {
    const { run, release: made } = await published();
    const big = {
      target: { kind: 'release', routingReleaseId: made.id },
      call: { variables: { note: 'x'.repeat(SIMULATION_LIMITS.bodyBytes) } },
    };
    expect((await run(big)).statusCode).toBe(413);
  });

  it('audits counts and modes, never the caller words or numbers', async () => {
    const { run, release: made, store } = await published();
    await run({
      target: { kind: 'release', routingReleaseId: made.id },
      call: { from: '+919812345678', variables: { secret: 'hunter2' } },
      turns: [speech('my card number is 4111 1111')],
      engines: {
        answers: [
          { node: 'intent', engine: 'llm', branch: 'sales', reason: 'caller said hunter2' },
        ],
      },
    });
    const entry = store.audits.find((audit) => audit.action === 'routing.simulate')!;
    expect(entry).toMatchObject({
      workspaceId: 'ws-routing',
      actorId: 'operator',
      resourceType: 'routing_point',
      payload: {
        target: 'release',
        routingReleaseId: made.id,
        turns: 1,
        answers: 1,
        load: 'empty',
        status: 'agent',
        liveCalls: 0,
        modes: { rules: 'real', decision: 'mock', llm: 'mock', external: 'mock' },
      },
    });
    const text = JSON.stringify(entry);
    for (const secret of ['4111', '9812345678', 'hunter2', 'my card'])
      expect(text).not.toContain(secret);
  });

  it('maps the simulator refusing a request to 409 or 422', async () => {
    const refusing = (code: string) =>
      scriptedSimulator({
        simulateRoute: async () => {
          throw Object.assign(new Error(`refused: ${code}`), {
            name: 'SimulationInputError',
            code,
          });
        },
      });
    for (const [code, status, error] of [
      ['live_engine_unavailable', 409, 'simulate_live_unavailable'],
      ['live_turns_exceeded', 422, 'routing_simulate_invalid'],
    ] as const) {
      const { run, release: made } = await published({ simulator: refusing(code) });
      const response = await run({ target: { kind: 'release', routingReleaseId: made.id } });
      expect([response.statusCode, response.json().error.code]).toEqual([status, error]);
    }
    const crashing = await published({
      simulator: scriptedSimulator({
        simulateRoute: async () => Promise.reject(new Error('boom')),
      }),
    });
    const crashed = await crashing.run({
      target: { kind: 'release', routingReleaseId: crashing.release.id },
    });
    expect(crashed.statusCode).toBe(500);
  });
});
