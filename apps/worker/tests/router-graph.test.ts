import { Cap, type RoutingHost, type SegmentHandoffPort } from '@winsendotai/ovo-contracts';
import { compose } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RELEASE,
  ROUTER_RELEASE,
  snapshot,
} from '../../../packages/contracts/tests/routing-fixture.ts';
import {
  ROUTING_HOST_SERVICE_ID,
  routerMediaClose,
  routerSegmentShape,
  routingHostService,
} from '../src/router-graph.ts';
import { routedAgentIds, routeEventSink } from '../src/routing-events.ts';
import { WorkerTelemetryRuntime } from '../src/telemetry-runtime.ts';
import { fixtureRelease } from './routed-fixtures.ts';

const host = { call: {}, now: () => 0 } as unknown as RoutingHost;
const handoff = { prepare: vi.fn(), commit: vi.fn(), abandon: vi.fn() } as SegmentHandoffPort;

describe('the router segment (routing design 7.3)', () => {
  it('offers the routing host and the handoff seam as one host service', async () => {
    const service = routingHostService(host, handoff);
    expect(service.manifest).toMatchObject({
      id: ROUTING_HOST_SERVICE_ID,
      scope: 'session',
      provides: [Cap.routing, Cap.segmentHandoff],
    });
    const composition = await compose([{ id: ROUTING_HOST_SERVICE_ID }], [service], {
      scope: 'session',
    });
    expect(composition.ctx.get(Cap.routing)).toBe(host);
    expect(composition.ctx.get(Cap.segmentHandoff)).toBe(handoff);
    await composition.dispose();
  });

  it('replaces the router release behaviour with the router, configured with the snapshot', () => {
    const routerRelease = fixtureRelease(ROUTER_RELEASE, 'front-desk', { mode: 'context' });
    const behavior = routingHostService(host, handoff);
    const routing = snapshot();
    const shape = routerSegmentShape({
      ...{ behavior, routerRelease, snapshot: routing, host, handoff },
      sessionId: 'session-1',
    });
    expect(shape.behavior).toEqual({
      definition: behavior,
      config: {
        agent: routerRelease.config,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
        routing,
      },
    });
    expect(shape.behavior!.config.agent).not.toBe(routerRelease.config);
    expect(shape.services!.map((service) => service.manifest.id)).toEqual([
      ROUTING_HOST_SERVICE_ID,
    ]);
  });

  it('hangs up with the router release unless the call is handing off', async () => {
    const close = vi.fn(async () => undefined);
    let handingOff = false;
    const hook = routerMediaClose(() => handingOff, close);
    await hook('behavior_completed');
    expect(close).toHaveBeenCalledWith('behavior_completed');
    handingOff = true;
    await hook('behavior_completed');
    expect(close).toHaveBeenCalledOnce();
    await routerMediaClose(() => false, undefined)('caller_hangup');
  });
});

describe('routed call events (routing design 7.4, 9.2)', () => {
  it('stamps a callback with the segment release and mirrors route events to telemetry', async () => {
    const append = vi.fn(async () => undefined);
    const audit = vi.fn();
    const sink = routeEventSink({ append }, { releaseId: DEFAULT_RELEASE, telemetry: { audit } });
    const callback = {
      dueAt: '2026-10-16T10:00:00+05:30',
      timezone: 'Asia/Kolkata',
      source: 'llm',
    };
    await sink.append('disposition', { disposition: 'callback', callback });
    await sink.append('disposition', {
      disposition: 'callback',
      callback: { ...callback, releaseId: ROUTER_RELEASE },
    });
    await sink.append('disposition', { disposition: 'sale' });
    await sink.append('route.node', {
      turn: 1,
      node: 'intent',
      engine: 'rules',
      outcome: 'matched',
    });
    expect(append.mock.calls).toEqual([
      [
        'disposition',
        { disposition: 'callback', callback: { ...callback, releaseId: DEFAULT_RELEASE } },
      ],
      [
        'disposition',
        { disposition: 'callback', callback: { ...callback, releaseId: ROUTER_RELEASE } },
      ],
      ['disposition', { disposition: 'sale' }],
      ['route.node', { turn: 1, node: 'intent', engine: 'rules', outcome: 'matched' }],
    ]);
    expect(audit.mock.calls).toEqual([
      ['route.node', { turn: 1, node: 'intent', engine: 'rules', outcome: 'matched' }],
    ]);
    expect(sink).not.toHaveProperty('flush');
    // Without an outcome store the route path still reaches telemetry.
    await routeEventSink(undefined, { releaseId: DEFAULT_RELEASE, telemetry: { audit } }).append(
      'route.segment',
      { index: 0 },
    );
    expect(audit).toHaveBeenLastCalledWith('route.segment', { index: 0 });
  });

  it('lists every agent a routed call can reach, once', () => {
    expect(routedAgentIds(snapshot()).sort()).toEqual([
      'front-desk',
      'sales-en',
      'sales-hi',
      'support',
    ]);
  });

  it('keeps transcript words only when every reachable agent keeps them', async () => {
    const runtime = WorkerTelemetryRuntime.fromRepository(
      { getCallProjection: async () => undefined } as never,
      {
        controlStore: { appendCallEvent: vi.fn() } as never,
        transcriptText: { default: 'store', agents: { 'sales-hi': 'omit' } },
      },
    );
    try {
      expect(runtime.strictestTranscriptText(['front-desk', 'sales-en'])).toBe('store');
      expect(runtime.strictestTranscriptText(['front-desk', 'sales-hi'])).toBe('omit');
    } finally {
      await runtime.close();
    }
  });
});
