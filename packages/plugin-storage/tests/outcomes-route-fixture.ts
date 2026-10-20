import { expect } from 'vitest';
import type { CallOutcomeStore } from '../src/outcomes/index.ts';
import { event } from './outcomes-fixture.ts';

export const ROUTING = {
  point: '11111111-1111-4111-8111-111111111111',
  release: '22222222-2222-4222-8222-222222222222',
  router: '33333333-3333-4333-8333-333333333333',
  member: '44444444-4444-4444-8444-444444444444',
  pool: '55555555-5555-4555-8555-555555555555',
};

/** A routed call as the router and the worker record it: router segment, decision, agent segment. */
export const ROUTED_CALL: readonly [string, Record<string, unknown>][] = [
  [
    'route.segment',
    { index: 0, role: 'router', agentId: 'front-desk', releaseId: ROUTING.router, reason: 'start' },
  ],
  ['route.node', { turn: 1, node: 'intent', engine: 'rules', outcome: 'no_match' }],
  [
    'route.node',
    {
      turn: 1,
      node: 'intent',
      engine: 'llm',
      outcome: 'matched',
      branch: 'sales',
      confidence: 0.9,
    },
  ],
  [
    'route.decision',
    {
      routingPointId: ROUTING.point,
      routingReleaseId: ROUTING.release,
      path: ['intent'],
      target: 'agent',
      agentId: 'sales-hi',
      releaseId: ROUTING.member,
      poolId: ROUTING.pool,
      memberId: 'sales-hi',
      language: 'hi',
      context: { intent: 'sales' },
      turns: 1,
      routeMs: 2_100,
    },
  ],
  [
    'route.segment',
    {
      index: 1,
      role: 'agent',
      agentId: 'sales-hi',
      releaseId: ROUTING.member,
      reason: 'route',
      prepareMs: 400,
      gapMs: 30,
    },
  ],
  ['call.outcome', { outcome: 'completed', reason: 'caller_hangup' }],
];

export const ROUTED_SUMMARY = {
  routingPointId: ROUTING.point,
  routingReleaseId: ROUTING.release,
  path: ['intent'],
  target: 'agent',
  agentId: 'sales-hi',
  releaseId: ROUTING.member,
  poolId: ROUTING.pool,
  memberId: 'sales-hi',
  language: 'hi',
  degraded: null,
  segments: 2,
  turns: 1,
  routeMs: 2_100,
  fallbacks: 0,
  reasks: 0,
};

/** Folds a routed call, a degraded one, one that hung up while routing, and a direct one. */
export async function expectRoutedOutcomes(store: CallOutcomeStore, workspaceId: string) {
  await store.append(
    workspaceId,
    'routed',
    ROUTED_CALL.map(([type, payload]) => event(type, payload)),
  );
  expect((await store.get(workspaceId, 'routed'))!.route).toEqual(ROUTED_SUMMARY);

  await store.append(workspaceId, 'degraded', [
    event('route.segment', {
      index: 0,
      role: 'agent',
      agentId: 'sales-en',
      releaseId: ROUTING.member,
      reason: 'degraded',
    }),
    event('route.decision', {
      routingPointId: ROUTING.point,
      routingReleaseId: ROUTING.release,
      path: [],
      target: 'agent',
      turns: 0,
      routeMs: 5,
      degraded: 'router_compose_failed',
    }),
  ]);
  expect((await store.get(workspaceId, 'degraded'))!.route).toMatchObject({
    target: 'agent',
    agentId: 'sales-en',
    releaseId: ROUTING.member,
    degraded: 'router_compose_failed',
    segments: 1,
  });

  await store.append(workspaceId, 'hung-up', [
    event(...ROUTED_CALL[0]!),
    event(...ROUTED_CALL[1]!),
  ]);
  expect((await store.get(workspaceId, 'hung-up'))!.route).toMatchObject({
    routingReleaseId: '',
    agentId: null,
    releaseId: null,
    segments: 1,
  });

  await store.append(workspaceId, 'direct', [
    event('call.outcome', { outcome: 'completed', reason: 'x' }),
  ]);
  expect((await store.get(workspaceId, 'direct'))!.route).toBeNull();
}
