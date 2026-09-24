import type { EndReason } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createProductionWorkerMediaRuntime } from '../src/worker-media-bootstrap.ts';

describe('production worker media termination', () => {
  it.each([
    'behavior_completed',
    'caller_hangup',
    'error:stt-ingress-capacity',
    'error:turn-failed',
    'caller_idle',
    'ownership_lost',
  ] as EndReason[])('fences and hangs up when the engine ends with %s', async (reason) => {
    const order: string[] = [];
    const route = {
      sessionId: 'session-1',
      jobId: 'job-1',
      workerId: 'worker-1',
      ownerEpoch: 7,
      carrierCallId: 'CA1',
      status: 'accepted',
    };
    const job = { id: 'job-1', payload: { releaseId: 'release-1' } };
    const store = {
      get: async () => job,
      getSessionRoute: async () => route,
      requestSessionTermination: async () => {
        order.push('fence');
        route.status = 'terminating';
        return { carrierCallId: 'CA1' };
      },
    };
    const runtime = createProductionWorkerMediaRuntime({
      httpServer: {} as never,
      gatewayUrl: 'ws://127.0.0.1:1/worker',
      gatewayToken: 'test',
      workerId: 'worker-1',
      onDisconnect: vi.fn(),
      store: store as never,
      controlStore: {} as never,
      secrets: {} as never,
      telemetry: {} as never,
      costs: {
        usageForJob: () => undefined,
        inferenceUsageForJob: () => undefined,
        finalize: async () => {
          order.push('cost-finalized');
        },
      } as never,
      extensions: { plugins: [], nativeHandlers: {} },
      recordings: {} as never,
      recordingRetentionDays: 30,
      speechCache: {} as never,
      telephony: {} as never,
      carriers: {
        forJob: async () => ({
          control: {
            hangup: async () => {
              order.push('hangup');
              return 'ok';
            },
          },
          carrier: { capabilities: { control: { hangup: 'rest' } } },
        }),
      } as never,
    });
    await (
      runtime as unknown as {
        onSessionClose(route: unknown, reason: EndReason): Promise<void>;
      }
    ).onSessionClose(route, reason);
    expect(order).toEqual(['cost-finalized', 'fence', 'hangup']);
  });
});
