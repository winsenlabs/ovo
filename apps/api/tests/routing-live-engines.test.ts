import { describe, expect, it, vi } from 'vitest';
import {
  Cap,
  RoutingEngineError,
  type DecisionPort,
  type Inference,
  type RoutingHost,
} from '@winsendotai/ovo-contracts';
import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import { createLiveEngineFactory, type ExternalCaller } from '../src/routing-live-engines.ts';
import { LiveEngineUnavailable, type LiveEngineRequest } from '../src/routing-simulator.ts';
import { ROUTER_RELEASE, WORKSPACE, release } from './routing-fixtures.ts';

/** What the fake plugins saw: the config they were composed with, and when they were torn down. */
function kit() {
  const configs: Record<string, unknown> = {};
  const disposed: string[] = [];
  const plugin = (
    id: string,
    provides: string[],
    requires: string[],
    provide: Record<string, unknown>,
  ) =>
    definePlugin(
      {
        id,
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides,
        requires,
        configSchema: { type: 'object' },
        secretFields: [],
      },
      (ctx, config) => {
        configs[id] = config;
        for (const [key, value] of Object.entries(provide))
          ctx.provide(key as never, value as never);
        ctx.effect(() => () => void disposed.push(id));
      },
    );
  const inference = {
    generate: async () => ({ kind: 'text', text: 'ok' }),
  } as unknown as Inference;
  const decision = { decide: async () => ({}) } as unknown as DecisionPort;
  const services = plugin(
    'fake-services',
    [Cap.operationStore, Cap.secrets, Cap.observability],
    [],
    { [Cap.operationStore]: {}, [Cap.secrets]: {}, [Cap.observability]: {} },
  );
  const catalog: PluginDefinition[] = [
    plugin('fake-llm', [Cap.inference], [Cap.secrets, Cap.usage], { [Cap.inference]: inference }),
    plugin('fake-decision', [Cap.decision], [Cap.secrets], { [Cap.decision]: decision }),
    plugin('needs-a-room', [Cap.inference], [Cap.mediaRoom], { [Cap.inference]: inference }),
    plugin('helper', ['test.helper'], [], { 'test.helper': {} }),
    plugin('needs-helper', [Cap.decision], ['test.helper'], { [Cap.decision]: decision }),
  ];
  return { configs, disposed, catalog, services, inference, decision };
}

const pick = (pluginId: string, extra: Record<string, unknown> = {}) => ({
  pluginId,
  version: '1.0.0',
  config: { model: 'm' },
  ...extra,
});
function routerRelease(selections: Record<string, unknown>, locked: string[], bindings = {}) {
  return {
    ...release(ROUTER_RELEASE, 'front-desk', { selections: selections as never }),
    plugins: locked.map((id) => ({ id, version: '1.0.0' })),
    providerBindings: bindings as never,
  };
}
const request = (modes: Partial<LiveEngineRequest['modes']> = {}): LiveEngineRequest => ({
  workspaceId: WORKSPACE,
  routerReleaseId: ROUTER_RELEASE,
  modes: { decision: 'mock', llm: 'mock', external: 'mock', ...modes },
  call: { routingPointId: 'point-1', routingReleaseId: 'release-1', variables: { account: '7' } },
});

function factory(
  built: ReturnType<typeof kit>,
  releaseRecord: ReturnType<typeof routerRelease> | undefined,
  extra: Partial<Parameters<typeof createLiveEngineFactory>[0]> = {},
) {
  return createLiveEngineFactory({
    store: { getRelease: async () => releaseRecord } as never,
    catalog: built.catalog,
    createServices: () => built.services,
    externalEnabled: true,
    ...extra,
  });
}

describe('live engines for the route tester: decision and LLM (R4, P2)', () => {
  it('composes the router release selections with its binding and credential, and disposes them', async () => {
    const built = kit();
    const record = routerRelease(
      {
        llm: pick('fake-llm', { bindingId: 'binding-1' }),
        decision: pick('fake-decision'),
      },
      ['fake-llm', 'fake-decision'],
      { llm: { id: 'binding-1', config: { endpoint: 'x' }, credentialId: 'cred-1' } },
    );
    const live = await factory(built, record).open(request({ llm: 'live', decision: 'live' }));
    expect(live.ports.inference).toBe(built.inference);
    expect(live.ports.decision).toBe(built.decision);
    expect(live.ports.external).toBeUndefined();
    // The plugin got what the release pinned: the binding's config, a credential reference and its own config.
    expect(built.configs['fake-llm']).toEqual({
      binding: { endpoint: 'x' },
      credentialRef: { credentialId: 'cred-1' },
      model: 'm',
    });
    expect(built.configs['fake-decision']).toEqual({ model: 'm' });
    expect(built.disposed).toEqual([]);
    await live.dispose();
    // The session services plugin is composed with them and goes with them.
    expect(built.disposed.sort()).toEqual(['fake-decision', 'fake-llm', 'fake-services']);
  });

  it('composes only the engines the request marks live', async () => {
    const built = kit();
    const record = routerRelease({ llm: pick('fake-llm'), decision: pick('fake-decision') }, [
      'fake-llm',
      'fake-decision',
    ]);
    const live = await factory(built, record).open(request({ decision: 'live' }));
    expect(live.ports).toEqual({ decision: built.decision });
    expect(built.configs['fake-llm']).toBeUndefined();
    await live.dispose();
    const none = await factory(built, record).open(request());
    expect(none.ports).toEqual({});
    await none.dispose();
  });

  it('follows a selected plugin to the plugin it requires among the release pinned ones', async () => {
    const built = kit();
    const record = routerRelease({ decision: pick('needs-helper') }, ['needs-helper', 'helper']);
    const live = await factory(built, record).open(request({ decision: 'live' }));
    expect(live.ports.decision).toBe(built.decision);
    expect(Object.keys(built.configs).sort()).toEqual(['fake-services', 'helper', 'needs-helper']);
    await live.dispose();
  });

  it('says why it cannot, with the engine named, and composes nothing it would not use', async () => {
    const built = kit();
    const open = (
      record: ReturnType<typeof routerRelease> | undefined,
      modes = { llm: 'live' } as never,
    ) => factory(built, record).open(request(modes));
    await expect(open(undefined)).rejects.toThrow(LiveEngineUnavailable);
    await expect(open(routerRelease({}, []))).rejects.toThrow('the router release selects no llm');
    await expect(
      open(routerRelease({ decision: pick('fake-decision') }, ['fake-decision']), {
        llm: 'live',
      } as never),
    ).rejects.toThrow('selects no llm');
    await expect(open(routerRelease({ llm: pick('not-installed') }, []))).rejects.toThrow(
      'not-installed is not installed',
    );
    // Needs a capability only a call has (a media room), or something no pinned plugin provides.
    await expect(
      open(routerRelease({ llm: pick('needs-a-room') }, ['needs-a-room'])),
    ).rejects.toThrow(`requires ${Cap.mediaRoom}`);
    await expect(
      open(routerRelease({ decision: pick('needs-helper') }, ['needs-helper']), {
        decision: 'live',
      } as never),
    ).rejects.toThrow('requires test.helper');
    expect(built.configs['needs-a-room']).toBeUndefined();
  });
});

describe('live engines for the route tester: the external engine (R4, P2)', () => {
  const answer = { branch: 'sales', confidence: 0.8, slots: {} };
  const input = { node: 'intent', branches: ['sales'] } as unknown as Parameters<
    RoutingHost['external']
  >[0];

  function wired(caller: ExternalCaller | undefined) {
    const forAgent = vi.fn(() => ({ resolve: async () => 'secret' }));
    const built = kit();
    return {
      forAgent,
      factory: factory(built, routerRelease({}, []), {
        ...(caller ? { callExternal: caller } : {}),
        secrets: { forAgent },
      }),
    };
  }

  it('signs and posts as a simulation: a sim- call id, the router agent credentials, the simulated flag', async () => {
    const callExternal = vi.fn(async () => answer as never);
    const { factory: made, forAgent } = wired(callExternal as never);
    expect(made.external).toBe(true);
    const live = await made.open({
      ...request({ external: 'live' }),
      call: { ...request().call, from: '+919812345678' },
    });
    const signal = new AbortController().signal;
    expect(await live.ports.external!(input, signal)).toEqual(answer);
    const [options, passed, passedSignal] = callExternal.mock.calls[0] as never[];
    expect(forAgent).toHaveBeenCalledWith('front-desk');
    expect(options).toMatchObject({
      enabled: true,
      workspaceId: WORKSPACE,
      simulated: true,
      call: {
        workspaceId: WORKSPACE,
        routingPointId: 'point-1',
        routingReleaseId: 'release-1',
        from: '+919812345678',
        variables: { account: '7' },
      },
    });
    expect((options as { call: { callId: string } }).call.callId).toMatch(/^sim-[0-9a-f-]{36}$/);
    expect(passed).toBe(input);
    expect(passedSignal).toBe(signal);
    await live.dispose();
  });

  it('hands the router the engine own error codes, and turns a surprise into a transport failure', async () => {
    const failing = (error: unknown) => wired((async () => Promise.reject(error)) as never);
    const timeout = await failing(new RoutingEngineError('timeout', 'timeout')).factory.open(
      request({ external: 'live' }),
    );
    await expect(
      timeout.ports.external!(input, new AbortController().signal),
    ).rejects.toMatchObject({ kind: 'timeout' });
    const crash = await failing(new Error('socket reset')).factory.open(
      request({ external: 'live' }),
    );
    await expect(crash.ports.external!(input, new AbortController().signal)).rejects.toMatchObject({
      kind: 'transport',
      message: 'transport',
    });
  });

  it('is not offered without the client or the credential resolver', async () => {
    const none = wired(undefined);
    expect(none.factory.external).toBe(false);
    await expect(none.factory.open(request({ external: 'live' }))).rejects.toThrow(
      'not available here',
    );
    const built = kit();
    const noSecrets = factory(built, routerRelease({}, []), {
      callExternal: (async () => answer) as never,
    });
    expect(noSecrets.external).toBe(false);
    await expect(noSecrets.open(request({ external: 'live' }))).rejects.toThrow(
      LiveEngineUnavailable,
    );
  });

  it('releases the composed engines when the external one cannot be set up', async () => {
    const built = kit();
    const record = routerRelease({ llm: pick('fake-llm') }, ['fake-llm']);
    await expect(
      factory(built, record).open(request({ llm: 'live', external: 'live' })),
    ).rejects.toThrow('not available here');
    expect(built.disposed.sort()).toEqual(['fake-llm', 'fake-services']);
  });
});
