import { describe, expect, it, vi } from 'vitest';
import {
  RoutingSimulationResult,
  SIMULATION_LIMITS,
  type SimulationRequest,
} from '@winsendotai/ovo-contracts';
import { ROUTER_RELEASE } from './routing-fixtures.ts';
import { r4Setup, scriptedSimulator } from './routing-sim-fixtures.ts';
import { editor, published, speech } from './routing-simulate-support.ts';

describe('POST /v1/routing/simulate: live engines (R4)', () => {
  const live = (mode: SimulationRequest['engines']['mode']) => ({
    engines: { mode },
  });
  function factory() {
    const opened: unknown[] = [];
    const disposed = vi.fn(async () => undefined);
    return {
      opened,
      disposed,
      llm: true,
      external: true,
      async open(request: unknown) {
        opened.push(request);
        return { ports: { inference: {} as never, decision: {} as never }, dispose: disposed };
      },
    };
  }

  it('refuses a live engine unless an admin asks, the flag is on and the factory is there', async () => {
    const engines = factory();
    const base = await published({ liveEngines: engines, simulateLiveEnabled: true });
    const body = {
      target: { kind: 'release', routingReleaseId: base.release.id },
      ...live({ llm: 'live' } as never),
    };
    expect((await base.run(body, editor)).statusCode).toBe(403);
    const off = await published({ liveEngines: engines, simulateLiveEnabled: false });
    const refusedOff = await off.run({
      ...body,
      target: { kind: 'release', routingReleaseId: off.release.id },
    });
    expect([
      refusedOff.statusCode,
      refusedOff.json().error.code,
      refusedOff.json().engines,
    ]).toEqual([409, 'simulate_live_unavailable', ['llm']]);
    const bare = await published({ simulateLiveEnabled: true });
    const refusedBare = await bare.run({
      ...body,
      target: { kind: 'release', routingReleaseId: bare.release.id },
    });
    expect(refusedBare.statusCode).toBe(409);
    expect(bare.simulator.calls.simulate).toEqual([]);
    expect(engines.opened).toEqual([]);
  });

  it('the external engine needs OVO_ROUTING_EXTERNAL_ENABLED as well', async () => {
    const engines = factory();
    const noExternal = await published({ liveEngines: engines, simulateLiveEnabled: true });
    const body = (id: string) => ({
      target: { kind: 'release', routingReleaseId: id },
      ...live({ external: 'live' } as never),
    });
    const refused = await noExternal.run(body(noExternal.release.id));
    expect([refused.statusCode, refused.json().engines]).toEqual([409, ['external']]);
    const ok = await published({ liveEngines: engines, externalEnabled: true });
    expect((await ok.run(body(ok.release.id))).statusCode).toBe(200);
  });

  it('composes the engines from the router release, passes them in, counts them and disposes them', async () => {
    const engines = factory();
    const {
      run,
      release: made,
      simulator,
    } = await published({
      liveEngines: engines,
      simulateLiveEnabled: true,
    });
    const response = await run({
      target: { kind: 'release', routingReleaseId: made.id },
      turns: [speech('hello')],
      ...live({ llm: 'live', decision: 'live' } as never),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = RoutingSimulationResult.parse(response.json());
    expect(body.engineModes).toMatchObject({ llm: 'live', decision: 'live', external: 'mock' });
    expect(body.stats.liveCalls).toBe(1);
    expect(engines.opened).toEqual([
      { workspaceId: 'ws-routing', routerReleaseId: ROUTER_RELEASE },
    ]);
    expect(simulator.calls.simulate[0]!.live).toBeDefined();
    expect(engines.disposed).toHaveBeenCalledTimes(1);
  });

  it('limits a live run to eight caller turns and still disposes when the router fails', async () => {
    const engines = factory();
    const { run, release: made } = await published({
      liveEngines: engines,
      simulateLiveEnabled: true,
    });
    const tooLong = await run({
      target: { kind: 'release', routingReleaseId: made.id },
      turns: Array.from({ length: SIMULATION_LIMITS.liveTurns + 1 }, () => ({ kind: 'silence' })),
      ...live({ llm: 'live' } as never),
    });
    expect([tooLong.statusCode, tooLong.json().error.code]).toEqual([
      422,
      'routing_simulate_invalid',
    ]);
    expect(engines.opened).toEqual([]);
    const failing = await published({
      liveEngines: engines,
      simulateLiveEnabled: true,
      simulator: scriptedSimulator({
        simulateRoute: async () => Promise.reject(new Error('boom')),
      }),
    });
    const crashed = await failing.run({
      target: { kind: 'release', routingReleaseId: failing.release.id },
      ...live({ llm: 'live' } as never),
    });
    expect(crashed.statusCode).toBe(500);
    expect(engines.disposed).toHaveBeenCalledTimes(1);
  });

  it('reports what live runs are offered in the status', async () => {
    const engines = factory();
    const { call } = await r4Setup({
      simulator: scriptedSimulator(),
      liveEngines: engines,
      simulateLiveEnabled: true,
      externalEnabled: false,
    });
    const status = (
      await call('GET', '/v1/routing/status', undefined, { 'x-role': 'viewer' })
    ).json();
    expect(status.simulate).toEqual({ enabled: true, liveLlm: true, liveExternal: false });
    expect(status.evalRuns).toBe(true);
  });
});
