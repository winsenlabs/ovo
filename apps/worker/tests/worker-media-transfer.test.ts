import type { EndReason } from '@winsendotai/ovo-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createProductionWorkerMediaRuntime } from '../src/worker-media-bootstrap.ts';

/** The engine-close path: the session factory's hook runs before the engine closes its media. */
function runtime(transfer?: Record<string, unknown>) {
  const order: string[] = [];
  const route = {
    sessionId: 'session-1',
    jobId: 'job-1',
    workerId: 'worker-1',
    ownerEpoch: 7,
    carrierCallId: 'CA1',
    status: 'accepted',
  };
  const job = { id: 'job-1', workspaceId: 'ws-1', payload: { releaseId: 'release-1' } };
  const handoff = vi.fn(async () => {
    order.push('handoff');
    return { kind: 'confirmed' as const, receiptId: 'r' };
  });
  const media = createProductionWorkerMediaRuntime({
    httpServer: {} as never,
    gatewayUrl: 'ws://127.0.0.1:1/worker',
    gatewayToken: 'test',
    workerId: 'worker-1',
    onDisconnect: vi.fn(),
    store: {
      get: async () => job,
      getSessionRoute: async () => route,
      requestSessionTermination: async () => {
        route.status = 'terminating';
        return { carrierCallId: 'CA1' };
      },
    } as never,
    controlStore: {
      getRelease: async () => ({ config: transfer ? { handoff: { transfer } } : {} }),
    } as never,
    secrets: {} as never,
    telemetry: {} as never,
    costs: { usageForJob: () => undefined, inferenceUsageForJob: () => undefined } as never,
    extensions: { plugins: [], nativeHandlers: {} },
    recordings: {} as never,
    recordingRetentionDays: 30,
    speechCache: {} as never,
    telephony: {} as never,
    carriers: {
      forJob: async () => ({
        control: {
          handoff,
          hangup: async () => {
            order.push('hangup');
            return 'ended';
          },
        },
        carrier: {
          capabilities: { carrierId: 'twilio', control: { hangup: 'rest', handoff: ['phone'] } },
        },
      }),
    } as never,
  });
  // The production factory, inside the wrapper that keeps the engine's end reason (N2).
  const close = (reason: EndReason) =>
    (
      media as unknown as {
        factory: {
          factory: {
            beforeEngineMediaClose(job: unknown, route: unknown, reason: EndReason): Promise<void>;
          };
        };
      }
    ).factory.factory.beforeEngineMediaClose(job, route, reason);
  return { close, order, handoff };
}

describe('the worker hands a transferred call to the release target (AGT-15)', () => {
  it('transfers instead of hanging up when the release has a target', async () => {
    const target = { kind: 'phone', e164: '+918041234567' };
    const { close, order, handoff } = runtime({ target });
    await close('transferred');
    expect(order).toEqual(['handoff']);
    expect(handoff).toHaveBeenCalledWith('CA1', target, 'transfer:session-1');
  });

  it('hangs up a transferred call whose release has no target, and any other ending', async () => {
    const untargeted = runtime();
    await untargeted.close('transferred');
    expect(untargeted.order).toEqual(['hangup']);
    const completed = runtime({ target: { kind: 'phone', e164: '+918041234567' } });
    await completed.close('behavior_completed');
    expect(completed.order).toEqual(['hangup']);
  });
});
