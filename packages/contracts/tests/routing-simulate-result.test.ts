import { describe, expect, it } from 'vitest';
import {
  PublishPreview,
  RoutingSimulationResult,
  SIMULATION_SCHEMA,
  type CallOutcomeRoute,
} from '../src/index.ts';
import { POINT_ID, SALES_EN_RELEASE } from './routing-fixture.ts';

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true);
const rejects = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);

const release = { kind: 'release', routingReleaseId: SALES_EN_RELEASE };

describe('RoutingSimulationResult', () => {
  const result = {
    schema: SIMULATION_SCHEMA,
    at: '2026-10-20T10:00:00.000Z',
    source: {
      kind: 'release',
      pointId: POINT_ID,
      routingReleaseId: SALES_EN_RELEASE,
      version: 2,
      digest: 'd'.repeat(64),
    },
    engineModes: { rules: 'real', decision: 'mock', llm: 'mock', external: 'mock' },
    assumed: { transferEnabled: false, humanQueueEnabled: false },
    turns: [
      {
        index: 0,
        input: { kind: 'opening' },
        say: 'Welcome.',
        phase: 'routing',
        virtualMs: 0,
        steps: [],
      },
      {
        index: 1,
        input: { kind: 'speech', text: 'sales please' },
        say: 'Connecting you now.',
        phase: 'announcing',
        virtualMs: 3000,
        steps: [
          {
            type: 'route.node',
            mocked: true,
            payload: {
              turn: 1,
              node: 'intent',
              engine: 'llm',
              outcome: 'matched',
              branch: 'sales',
              confidence: 0.9,
            },
          },
          {
            type: 'route.decision',
            payload: {
              routingPointId: POINT_ID,
              routingReleaseId: SALES_EN_RELEASE,
              path: ['intent'],
              target: 'agent',
              turns: 1,
              routeMs: 3000,
            },
          },
          { type: 'disclosure', payload: { kinds: ['ai'] } },
        ],
      },
    ],
    outcome: {
      status: 'agent',
      completionReason: 'route:agent:intent>sales',
      node: 'intent',
      path: ['intent'],
      language: 'en',
      context: { intent: 'sales' },
      turns: 1,
      routeMs: 3000,
      line: 'Connecting you now.',
      degraded: null,
      agent: {
        agentId: 'sales-en',
        releaseId: SALES_EN_RELEASE,
        poolId: POINT_ID,
        memberId: 'sales-en',
      },
      targetVariables: { ovo_route_intent: 'sales' },
      human: null,
      callback: null,
      endDisposition: null,
    },
    pools: [],
    warnings: [
      { code: 'engine_unscripted', node: 'intent', engine: 'llm', message: 'No mock answer' },
    ],
    stats: { ms: 4, virtualMs: 3000, routerTurns: 2, liveCalls: 0 },
  };

  it('accepts a complete result', () => {
    accepts(RoutingSimulationResult, result);
  });

  it('accepts a human outcome with a precheck failure', () => {
    accepts(RoutingSimulationResult, {
      ...result,
      outcome: {
        ...result.outcome,
        status: 'human',
        agent: null,
        human: { queueKey: 'desk', queueId: POINT_ID, kind: 'managed', precheck: 'no_operators' },
      },
    });
  });

  it('rejects a wrong schema id, an unknown phase, an unknown warning and a bad precheck', () => {
    rejects(RoutingSimulationResult, { ...result, schema: 'ovo.route-simulation/2' });
    rejects(RoutingSimulationResult, {
      ...result,
      turns: [{ ...result.turns[0], phase: 'sleeping' }],
    });
    rejects(RoutingSimulationResult, { ...result, warnings: [{ code: 'weird', message: 'x' }] });
    accepts(RoutingSimulationResult, {
      ...result,
      warnings: [{ code: 'simulation_aborted', message: 'The wall-clock guard stopped the run.' }],
    });
    rejects(RoutingSimulationResult, {
      ...result,
      outcome: {
        ...result.outcome,
        human: { queueKey: 'd', queueId: 'q', kind: 'managed', precheck: 'on_fire' },
      },
    });
    rejects(RoutingSimulationResult, {
      ...result,
      engineModes: { ...result.engineModes, rules: 'mock' },
    });
  });
});

describe('PublishPreview', () => {
  const issue = {
    code: 'routing_node_unreachable',
    severity: 'warning',
    path: ['nodes', 1],
    message: 'x',
  };
  const preview = {
    issues: [issue],
    blockers: [],
    warnings: [issue],
    canPublish: true,
    nextVersion: 2,
    digest: 'e'.repeat(64),
    previous: {
      id: SALES_EN_RELEASE,
      version: 1,
      digest: 'f'.repeat(64),
      createdAt: '2026-10-20T10:00:00.000Z',
    },
    unchanged: false,
    changes: [
      { area: 'node', op: 'added', key: 'node a', path: ['nodes', 1], summary: 'Node a added' },
    ],
    pins: [{ path: ['router'], agentId: 'front-desk', was: 'latest', releaseId: SALES_EN_RELEASE }],
  };

  it('accepts a preview and one blocked with no digest', () => {
    accepts(PublishPreview, preview);
    accepts(PublishPreview, {
      ...preview,
      canPublish: false,
      digest: null,
      previous: null,
      changes: [],
    });
  });

  it('rejects an unknown issue code, a short digest and version 0', () => {
    rejects(PublishPreview, { ...preview, issues: [{ ...issue, code: 'routing_made_up' }] });
    rejects(PublishPreview, { ...preview, digest: 'abc' });
    rejects(PublishPreview, { ...preview, nextVersion: 0 });
    rejects(PublishPreview, { ...preview, pins: [{ ...preview.pins[0], was: 'newest' }] });
  });
});

describe('CallOutcomeRoute (R4 additions)', () => {
  it('keeps the new fields optional', () => {
    const old: CallOutcomeRoute = {
      routingPointId: 'p',
      routingReleaseId: 'r',
      path: [],
      target: 'agent',
      agentId: null,
      releaseId: null,
      poolId: null,
      memberId: null,
      language: null,
      degraded: null,
      segments: 1,
    };
    const next: CallOutcomeRoute = { ...old, turns: 2, routeMs: null, fallbacks: 1, reasks: 0 };
    expect(old.turns).toBeUndefined();
    expect(next.fallbacks).toBe(1);
  });
});
