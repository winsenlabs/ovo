import { describe, expect, it } from 'vitest';
import {
  CallbackRequest,
  Cap,
  CAPABILITY_SPECS,
  ExternalDecisionResponse,
  readSessionEvent,
  RouteDecisionPayload,
  RouteFallbackPayload,
  RouteNodePayload,
  RouteSegmentPayload,
  RoutingEngineError,
  RoutingReleaseSnapshot,
  routingAgentRefs,
  SegmentHandoffRequest,
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_TYPES,
  type CapabilityMap,
  type RoutingHost,
  type SegmentHandoffPort,
} from '../src/index.ts';
import {
  DEFAULT_RELEASE,
  POINT_ID,
  POOL_SALES,
  ROUTER_RELEASE,
  SALES_HI_RELEASE,
  draft,
  snapshot,
  snapshotInput,
} from './routing-fixture.ts';

const decision = {
  routingPointId: POINT_ID,
  routingReleaseId: ROUTER_RELEASE,
  path: ['intent'],
  target: 'agent',
  agentId: 'sales-hi',
  releaseId: SALES_HI_RELEASE,
  poolId: POOL_SALES,
  memberId: 'sales-hi',
  language: 'hi',
  context: { intent: 'sales' },
  turns: 1,
  routeMs: 2_140,
};

describe('routing release snapshot', () => {
  it('accepts a fully pinned snapshot', () => {
    expect(snapshot().releaseIds).toHaveLength(5);
  });

  it('refuses latest refs, missing pools, unlisted releases and structural errors', () => {
    const refuse = (patch: (s: Record<string, any>) => void) => {
      const input = snapshotInput();
      patch(input);
      return (
        RoutingReleaseSnapshot.safeParse(input).error?.issues.map((issue) => issue.message) ?? []
      );
    };
    expect(
      refuse(
        (s) =>
          (s.nodes[0].branches[0].target = {
            kind: 'agent',
            agent: { agentId: 'x', release: { kind: 'latest' } },
          }),
      ),
    ).toEqual(['A release snapshot pins every agent reference']);
    expect(refuse((s) => delete s.pools[POOL_SALES])).toEqual([
      'The snapshot holds every pool a target names',
    ]);
    expect(refuse((s) => (s.releaseIds = s.releaseIds.slice(0, 4)))).toEqual([
      expect.stringMatching(/referenced but not listed/),
    ]);
    expect(refuse((s) => s.releaseIds.push(ROUTER_RELEASE))).toEqual([
      'Release ids are de-duplicated',
    ]);
    expect(refuse((s) => (s.root = 'nowhere'))).toEqual([
      expect.stringMatching(/^routing_root_missing/),
    ]);
    expect(refuse((s) => (s.router.release = { kind: 'latest' }))).not.toEqual([]);
    expect(refuse((s) => (s.pools[POOL_SALES].id = DEFAULT_RELEASE))).toEqual([
      'A pool snapshot is keyed by its id',
    ]);
  });

  it('lists every agent reference with its path', () => {
    const refs = routingAgentRefs(
      draft((d) => {
        d.nodes[0].branches[0].target = {
          kind: 'agent',
          agent: { agentId: 'cards', release: { kind: 'latest' } },
        };
        d.nodes[0].fallback.splice(2, 0, {
          kind: 'callback',
          line: { en: 'We will call you.' },
          agent: { agentId: 'cb', release: { kind: 'latest' } },
        });
      }),
    );
    expect(refs.map((ref) => [ref.path.join('.'), ref.ref.agentId])).toEqual([
      ['router', 'front-desk'],
      ['defaultTarget', 'sales-en'],
      ['nodes.0.branches.0.target.agent', 'cards'],
      ['nodes.0.fallback.2.agent', 'cb'],
    ]);
  });
});

describe('routing runtime contracts', () => {
  it('validates handoff requests: only ovo_route_ variables, a uuid release', () => {
    const request = {
      kind: 'agent',
      reason: 'route',
      agentId: 'sales-hi',
      releaseId: SALES_HI_RELEASE,
    };
    expect(SegmentHandoffRequest.parse(request).variables).toEqual({});
    expect(
      SegmentHandoffRequest.safeParse({
        ...request,
        variables: { ovo_route_intent: 'sales' },
        route: { path: ['intent'], poolId: POOL_SALES, memberId: 'sales-hi' },
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...request, variables: { account: '1' } },
      { ...request, releaseId: 'latest' },
      { ...request, reason: 'transfer' },
      { ...request, kind: 'human' },
      { ...request, route: { path: Array.from({ length: 33 }, () => 'n') } },
    ])
      expect(SegmentHandoffRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('validates external decision responses', () => {
    expect(ExternalDecisionResponse.parse({ branch: 'sales' })).toEqual({
      branch: 'sales',
      confidence: 1,
      slots: {},
    });
    expect(
      ExternalDecisionResponse.parse({ branch: null, confidence: 0.2, extra: 1 }),
    ).toMatchObject({ branch: null, extra: 1 });
    for (const bad of [
      {},
      { branch: 'Sales' },
      { branch: 'x', confidence: 2 },
      { branch: 'x', slots: { bad_Key: 'x' } },
    ])
      expect(ExternalDecisionResponse.safeParse(bad).success).toBe(false);
  });

  it('carries the engine error kind', () => {
    const error = new RoutingEngineError('timeout', 'slow');
    expect(error).toBeInstanceOf(Error);
    expect([error.kind, error.message, error.name]).toEqual([
      'timeout',
      'slow',
      'RoutingEngineError',
    ]);
  });

  it('registers the routing and segment-handoff capabilities as session keys', () => {
    expect(Cap.routing).toBe('ovo.routing');
    expect(Cap.segmentHandoff).toBe('ovo.segment-handoff');
    for (const key of [Cap.routing, Cap.segmentHandoff])
      expect(CAPABILITY_SPECS[key]).toEqual({ major: 1, cardinality: 'one', scope: 'session' });
    const typed: [CapabilityMap['ovo.routing'], CapabilityMap['ovo.segment-handoff']] = [
      {} as RoutingHost,
      {} as SegmentHandoffPort,
    ];
    expect(typed).toHaveLength(2);
  });

  it('lets a callback come from a route, with the release to dial', () => {
    const callback = {
      dueAt: '2026-10-15T18:00:00+05:30',
      timezone: 'Asia/Kolkata',
      source: 'route',
      node: 'intent',
    };
    expect(CallbackRequest.parse({ ...callback, releaseId: SALES_HI_RELEASE })).toMatchObject({
      source: 'route',
      releaseId: SALES_HI_RELEASE,
    });
    expect(CallbackRequest.safeParse({ ...callback, source: 'router' }).success).toBe(false);
    expect(CallbackRequest.safeParse({ ...callback, releaseId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('route session events', () => {
  it('appends the four route types and validates each payload', () => {
    expect(SESSION_EVENT_TYPES.slice(-4)).toEqual([
      'route.node',
      'route.fallback',
      'route.decision',
      'route.segment',
    ]);
    for (const [type, payload] of [
      [
        'route.node',
        {
          turn: 1,
          node: 'intent',
          engine: 'llm',
          outcome: 'matched',
          branch: 'sales',
          confidence: 0.91,
          ms: 640,
          modelId: 'm',
        },
      ],
      ['route.fallback', { turn: 2, node: 'intent', step: 'reask', result: 'taken', attempt: 1 }],
      ['route.decision', decision],
      [
        'route.segment',
        {
          index: 1,
          role: 'agent',
          agentId: 'sales-hi',
          releaseId: SALES_HI_RELEASE,
          reason: 'route',
          prepareMs: 420,
          gapMs: 35,
        },
      ],
    ] as const)
      expect(readSessionEvent(type, payload).type).toBe(type);
    expect(
      readSessionEvent('route.segment', {
        index: 0,
        role: 'router',
        agentId: 'a',
        releaseId: 'r',
        reason: 'start',
        gapDroppedMs: 4,
      }).payload,
    ).toMatchObject({ gapDroppedMs: 4 });
  });

  it('refuses malformed route payloads', () => {
    for (const [schema, bad] of [
      [RouteNodePayload, { turn: 0, node: 'intent', engine: 'jev', outcome: 'matched' }],
      [RouteNodePayload, { turn: -1, node: 'intent', engine: 'llm', outcome: 'matched' }],
      [
        RouteFallbackPayload,
        { turn: 0, node: 'intent', step: 'transfer', result: 'taken', attempt: 1 },
      ],
      [RouteFallbackPayload, { turn: 0, node: 'intent', step: 'end', result: 'taken', attempt: 0 }],
      [RouteDecisionPayload, { ...decision, target: 'human' }],
      [
        RouteDecisionPayload,
        {
          ...decision,
          context: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])),
        },
      ],
      [RouteDecisionPayload, { ...decision, path: Array.from({ length: 33 }, () => 'n') }],
      [
        RouteSegmentPayload,
        { index: 0, role: 'human', agentId: 'a', releaseId: 'r', reason: 'start' },
      ],
    ] as const)
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('keeps the 8 KiB cap on route events', () => {
    const big = { ...decision, note: 'x'.repeat(SESSION_EVENT_MAX_BYTES) };
    expect(RouteDecisionPayload.safeParse(big).success).toBe(true);
    expect(() => readSessionEvent('route.decision', big)).toThrow(/limit/);
  });
});
