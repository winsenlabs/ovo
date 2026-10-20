import { ExternalEngine, ROUTE_DECISION_SCHEMA } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import * as worker from '../../../apps/worker/src/routing-external.ts';
import {
  callExternalRouteEngine,
  routeDecisionSignature,
  type ExternalRouteOptions,
} from '../src/index.ts';

/*
 * The external decision client moved here from the worker (the API's route tester needs it too).
 * Its full behaviour is covered by apps/worker/tests/routing-external.test.ts, which runs unchanged
 * through the worker's re-export; this file covers the additive `simulated` marker and the move.
 */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
const engine = ExternalEngine.parse({
  kind: 'external',
  endpoint: 'https://decide.example.test/route',
  credentialId: 'cred-route',
  timeoutMs: 200,
});
const input = {
  node: 'intent',
  engine,
  turn: { text: 'a new card' },
  context: { values: {} },
  branches: ['sales', 'support'],
};

function options(
  sent: { body?: Record<string, unknown> },
  over: Partial<ExternalRouteOptions> = {},
) {
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ branch: 'sales', confidence: 0.9 }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    enabled: true,
    workspaceId: 'workspace-1',
    secrets: { resolve: async () => 'route-secret' },
    call: {
      callId: 'sim-4f6d',
      workspaceId: 'workspace-1',
      routingPointId: 'point-1',
      routingReleaseId: 'release-1',
      variables: {},
    },
    network: { lookup: publicLookup, fetch: fetch as unknown as typeof globalThis.fetch },
    now: () => 1_760_000_000_000,
    requestId: () => 'req-1',
    ...over,
  } satisfies ExternalRouteOptions;
}

describe('routing-external in the session host', () => {
  it('marks a simulation request, additively to ovo.route-decision/1', async () => {
    const sent: { body?: Record<string, unknown> } = {};
    await callExternalRouteEngine(
      options(sent, { simulated: true }),
      input,
      new AbortController().signal,
    );
    expect(sent.body).toMatchObject({
      schema: ROUTE_DECISION_SCHEMA,
      callId: 'sim-4f6d',
      simulated: true,
      node: 'intent',
    });
  });

  it('sends a real call exactly as before: no simulated field', async () => {
    for (const over of [{}, { simulated: false }]) {
      const sent: { body?: Record<string, unknown> } = {};
      await callExternalRouteEngine(options(sent, over), input, new AbortController().signal);
      expect(sent.body).not.toHaveProperty('simulated');
    }
  });

  it('is the same client the worker re-exports, and signs with the shared webhook scheme', () => {
    expect(worker.callExternalRouteEngine).toBe(callExternalRouteEngine);
    expect(worker.routeDecisionSignature).toBe(routeDecisionSignature);
    expect(routeDecisionSignature('secret', '1760000000', 'req-1', '{}')).toMatch(
      /^v1=[0-9a-f]{64}$/,
    );
  });
});
