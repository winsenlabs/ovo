import { OPERATIONS_SERVICE_KEY } from '@winsendotai/ovo-plugin-operations';
import { createRouterBehaviorPlugin } from '@winsendotai/ovo-plugin-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutedVoiceSessionFactory } from '../src/routed-session-factory.ts';
import { createProductionWorkerMediaRuntime } from '../src/worker-media-bootstrap.ts';

/** The factory the worker media runtime builds, under the N2 end-reason wrapper. */
function routedFactory(graph?: unknown, operations?: unknown) {
  const media = createProductionWorkerMediaRuntime({
    ...{ httpServer: {} as never, gatewayUrl: 'ws://127.0.0.1:1/worker', gatewayToken: 'test' },
    ...{
      workerId: 'worker-1',
      onDisconnect: vi.fn(),
      store: {} as never,
      controlStore: {} as never,
    },
    ...{
      secrets: {} as never,
      telemetry: {} as never,
      extensions: { plugins: [], nativeHandlers: {} },
    },
    costs: { usageForJob: () => undefined, inferenceUsageForJob: () => undefined } as never,
    ...{ recordings: {} as never, recordingRetentionDays: 30, speechCache: {} as never },
    telephony: {} as never,
    ...(graph ? { graph: graph as never } : {}),
    ...(operations ? { operations: operations as never } : {}),
  });
  const factory = (media as unknown as { factory: { factory: unknown } }).factory.factory;
  return { factory, routing: (factory as { routing: Record<string, unknown> }).routing };
}

describe('the worker media runtime opens routed calls (Wave 15)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes with the process operations service and the routing environment', () => {
    vi.stubEnv('OVO_ROUTING_EXTERNAL_ENABLED', 'true');
    vi.stubEnv('OVO_ROUTING_PREPARE_TIMEOUT_MS', '4000');
    const operations = { routing: { releases: {}, claims: {} } };
    const graph = {
      parent: {
        ctx: {
          get: (key: string) => {
            if (key === OPERATIONS_SERVICE_KEY) return operations;
            throw new Error(`missing ${key}`);
          },
        },
      },
    };
    const { factory, routing } = routedFactory(graph);
    expect(factory).toBeInstanceOf(RoutedVoiceSessionFactory);
    expect(routing).toEqual({
      routing: operations.routing,
      routerBehavior: createRouterBehaviorPlugin,
      externalEnabled: true,
      prepareTimeoutMs: 4_000,
    });
  });

  it('keeps routing storage absent (routed calls degrade) without an operations service', () => {
    vi.stubEnv('OVO_ROUTING_EXTERNAL_ENABLED', '');
    const graph = {
      parent: {
        ctx: {
          get: () => {
            throw new Error('not composed');
          },
        },
      },
    };
    expect(routedFactory(graph).routing).toMatchObject({
      routing: undefined,
      externalEnabled: false,
      prepareTimeoutMs: 2_500,
    });
    const operations = { routing: { releases: {}, claims: {} } };
    expect(routedFactory(undefined, operations).routing.routing).toBe(operations.routing);
  });
});
