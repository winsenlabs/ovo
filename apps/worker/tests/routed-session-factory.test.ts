import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { Cap } from '@winsendotai/ovo-contracts';
import {
  DEFAULT_RELEASE,
  POINT_ID,
  POOL_SUPPORT,
  ROUTER_RELEASE,
  SUPPORT_RELEASE,
  snapshot,
} from '../../../packages/contracts/tests/routing-fixture.ts';
import { routedJob } from '../src/routed-session-factory.ts';
import { fixtureRelease, routedCall } from './routed-fixtures.ts';

const ROUTING_RELEASE = '99999999-9999-4999-8999-999999999999';
const routing = {
  routingReleaseId: ROUTING_RELEASE,
  routingPointId: POINT_ID,
  version: 3,
  defaultReleaseId: DEFAULT_RELEASE,
};
const releases = () => [
  fixtureRelease(ROUTER_RELEASE, 'front-desk', { mode: 'context', maxCallSeconds: 600 }),
  fixtureRelease(DEFAULT_RELEASE, 'sales-en'),
  // Declares the route's intent, not the caller's name: only the intent reaches it.
  fixtureRelease(SUPPORT_RELEASE, 'support', {
    variables: {
      type: 'object',
      properties: { ovo_route_intent: { type: 'string' } },
      additionalProperties: false,
    },
  }),
];
const stored = (overrides: Record<string, unknown> = {}) => ({
  id: ROUTING_RELEASE,
  routingPointId: POINT_ID,
  snapshot: snapshot(),
  ...overrides,
});

describe('routed jobs (routing design 7.2)', () => {
  it('reads payload.routing only when every id is well formed', () => {
    expect(routedJob({ routing })).toEqual(routing);
    expect(routedJob({})).toBeUndefined();
    expect(routedJob({ routing: null })).toBeUndefined();
    expect(routedJob({ routing: { ...routing, defaultReleaseId: 'nope' } })).toBeUndefined();
    expect(routedJob({ routing: { ...routing, version: '3' } })).toBeUndefined();
  });

  it('takes the production path, unchanged, for a job without routing', async () => {
    const call = await routedCall({ releases: releases(), routerReleaseId: DEFAULT_RELEASE });
    const session = await call.open();
    expect(call.getRouting).not.toHaveBeenCalled();
    expect(call.routers).toEqual([]);
    expect(call.engines.map((engine) => engine.releaseId)).toEqual([DEFAULT_RELEASE]);
    expect(call.createSession.mock.calls[0]![0]).not.toHaveProperty('transcriptText');
    await session.dispose('caller_hangup');
    expect(call.claims.release).not.toHaveBeenCalled();
    expect((await call.events()).map(([type]) => type)).toEqual(['call.outcome']);
  });

  it.each([
    ['the routing release is missing', async () => undefined],
    ['reading it fails', async () => Promise.reject(new Error('operations down'))],
    ['reading it outlasts the bound', () => new Promise<never>(() => undefined)],
    [
      'its router is not the job release',
      async () =>
        stored({
          snapshot: {
            ...snapshot(),
            router: { agentId: 'x', release: { kind: 'pinned', releaseId: DEFAULT_RELEASE } },
          },
        }),
    ],
  ])('degrades to the default target as segment 0 when %s', async (_name, getRouting) => {
    const call = await routedCall({
      releases: releases(),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting,
    });
    const session = await call.open();
    expect(call.createCall).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'call-1', releaseId: ROUTER_RELEASE }),
    );
    expect(call.routers).toEqual([]);
    expect(call.engines.map((engine) => [engine.releaseId, engine.started])).toEqual([
      [DEFAULT_RELEASE, true],
    ]);
    expect(call.audits).toContainEqual(['route.degraded', { reason: 'snapshot_unavailable' }]);
    await session.dispose('caller_hangup');
    expect(call.claims.release).toHaveBeenCalledWith('job-1');
    expect(await call.events()).toEqual([
      [
        'route.decision',
        expect.objectContaining({
          routingPointId: POINT_ID,
          routingReleaseId: ROUTING_RELEASE,
          path: [],
          target: 'agent',
          agentId: 'sales-en',
          releaseId: DEFAULT_RELEASE,
          degraded: 'snapshot_unavailable',
        }),
      ],
      [
        'route.segment',
        expect.objectContaining({
          index: 0,
          role: 'agent',
          reason: 'degraded',
          releaseId: DEFAULT_RELEASE,
        }),
      ],
      ['call.outcome', expect.objectContaining({ reason: 'caller_hangup' })],
    ]);
  });

  it('degrades when the router cannot be composed', async () => {
    const broken = definePlugin(
      {
        id: '@fixture/broken-router',
        version: '1.0.0',
        contractVersion: 1,
        scope: 'session',
        provides: [Cap.behavior],
        requires: [Cap.routing],
        configSchema: { type: 'object' },
        secretFields: [],
      },
      () => {
        throw new Error('router refused its snapshot');
      },
    );
    const call = await routedCall({
      releases: releases(),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting: async () => stored(),
      routerBehavior: () => broken,
    });
    const session = await call.open();
    expect(call.engines.map((engine) => [engine.releaseId, engine.started])).toEqual([
      [DEFAULT_RELEASE, true],
    ]);
    expect(call.audits).toContainEqual(['route.degraded', { reason: 'router_compose_failed' }]);
    await session.dispose('caller_hangup');
    expect((await call.events())[0]).toEqual([
      'route.decision',
      expect.objectContaining({ degraded: 'router_compose_failed', releaseId: DEFAULT_RELEASE }),
    ]);
  });

  it('records with the strictest transcript policy of every agent the call can reach', async () => {
    const strict = await routedCall({
      releases: releases(),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting: async () => stored(),
      transcriptOmitted: ['sales-hi'],
    });
    await (await strict.open()).dispose('caller_hangup');
    expect(strict.createSession.mock.calls[0]![0]).toMatchObject({ transcriptText: 'omit' });
    const open = await routedCall({
      releases: releases(),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting: async () => stored(),
      transcriptOmitted: ['someone-else'],
    });
    await (await open.open()).dispose('caller_hangup');
    expect(open.createSession.mock.calls[0]![0]).toMatchObject({ transcriptText: 'store' });
  });

  it.each([
    [['sales-en'], 'omit'],
    [['someone-else'], 'store'],
  ])(
    'counts the default agent when the snapshot cannot load (omitted %j: %s)',
    async (transcriptOmitted, transcriptText) => {
      const call = await routedCall({
        releases: releases(),
        routerReleaseId: ROUTER_RELEASE,
        routing,
        getRouting: async () => Promise.reject(new Error('operations down')),
        transcriptOmitted,
      });
      await (await call.open()).dispose('caller_hangup');
      expect(call.engines.map((engine) => engine.releaseId)).toEqual([DEFAULT_RELEASE]);
      expect(call.createSession.mock.calls[0]![0]).toMatchObject({ transcriptText });
    },
  );

  it('omits transcript text when neither the snapshot nor the default release can be read', async () => {
    const call = await routedCall({
      releases: releases().filter((release) => release.id !== DEFAULT_RELEASE),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting: async () => undefined,
    });
    await call.open().catch(() => undefined);
    expect(call.createSession.mock.calls[0]![0]).toMatchObject({ transcriptText: 'omit' });
  });

  it('runs the router, then hands the call to the chosen agent on the same link', async () => {
    const call = await routedCall({
      releases: releases(),
      routerReleaseId: ROUTER_RELEASE,
      routing,
      getRouting: async () => stored(),
    });
    const session = await call.open();
    const [router] = call.routers;
    expect(router!.config).toMatchObject({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      agent: { name: 'front-desk', mode: 'context' },
      routing: { routingPointId: POINT_ID, root: 'intent' },
    });
    expect(router!.host.call).toEqual({
      callId: 'call-1',
      workspaceId: 'workspace-1',
      routingPointId: POINT_ID,
      routingReleaseId: ROUTING_RELEASE,
      from: '+919800000001',
      to: '+918000000002',
      variables: { customer: 'Asha' },
    });
    const prepared = await router!.handoff.prepare(
      {
        kind: 'agent',
        reason: 'route',
        agentId: 'support',
        releaseId: SUPPORT_RELEASE,
        variables: { ovo_route_intent: 'support' },
        route: { path: ['intent'], poolId: POOL_SUPPORT, memberId: 'support' },
      },
      new AbortController().signal,
    );
    if (!prepared.ok) throw new Error(prepared.reason);
    const [routerEngine, agentEngine] = call.engines;
    expect(agentEngine).toMatchObject({ releaseId: SUPPORT_RELEASE, started: false });
    const session1 = agentEngine!.config.session as Record<string, unknown>;
    expect(session1.variables).toEqual({ ovo_route_intent: 'support' });
    expect(session1.maxCallSeconds).toBeGreaterThanOrEqual(599);
    expect(session1.maxCallSeconds).toBeLessThanOrEqual(600);
    router!.handoff.commit(prepared.handoffId);
    await router!.events!.append('disposition', {
      disposition: 'callback',
      callback: { dueAt: '2026-10-16T10:00:00+05:30', timezone: 'Asia/Kolkata', source: 'route' },
    });
    await routerEngine!.complete();
    await vi.waitFor(() => expect(agentEngine!.started).toBe(true));
    // The router's ending neither hung up nor closed the link.
    expect(call.beforeClose).not.toHaveBeenCalled();
    expect(call.link.closed).toEqual([]);
    expect(routerEngine!.disposed).toBe('behavior_completed');
    // The agent's ids carry its segment before any writer sees them.
    agentEngine!.emit({ type: 'user.turn', phase: 'started', turnId: 'turn-1' });
    expect(call.telemetry.engineEvent).toHaveBeenLastCalledWith({
      type: 'user.turn',
      phase: 'started',
      turnId: 's1:turn-1',
    });
    await agentEngine!.complete();
    expect(call.beforeClose).toHaveBeenCalledOnce();
    expect(call.beforeClose.mock.calls[0]![0].payload.releaseId).toBe(SUPPORT_RELEASE);
    expect(call.link.closed).toEqual(['behavior_completed']);
    await session.dispose('behavior_completed');
    expect(call.claims.release).toHaveBeenCalledWith('job-1');
    expect(await call.events()).toEqual([
      [
        'route.segment',
        {
          index: 0,
          role: 'router',
          reason: 'start',
          agentId: 'front-desk',
          releaseId: ROUTER_RELEASE,
        },
      ],
      [
        'disposition',
        expect.objectContaining({
          callback: expect.objectContaining({ releaseId: DEFAULT_RELEASE }),
        }),
      ],
      [
        'route.segment',
        expect.objectContaining({
          index: 1,
          role: 'agent',
          reason: 'route',
          agentId: 'support',
          releaseId: SUPPORT_RELEASE,
          poolId: POOL_SUPPORT,
          memberId: 'support',
          prepareMs: expect.any(Number),
          gapMs: expect.any(Number),
        }),
      ],
      ['call.outcome', expect.objectContaining({ reason: 'behavior_completed' })],
    ]);
    expect(call.audits.map(([type]) => type)).toEqual(
      expect.arrayContaining(['route.segment', 'route.handoff.prepared']),
    );
  });
});
