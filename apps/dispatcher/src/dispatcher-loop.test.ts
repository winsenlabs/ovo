import { afterEach, describe, expect, it, vi } from 'vitest';
import { DispatcherLoop } from './dispatcher-loop.ts';
import type { CapacitySignalInput } from '@winsendotai/ovo-plugin-orchestration';

function capacity(nowMs = Date.now()): CapacitySignalInput {
  return {
    nowMs,
    observedAtMs: nowMs - 1_000,
    maxMetricAgeMs: 15_000,
    counts: { readyIdle: 2, reserved: 1, active: 1, starting: 0, draining: 0, total: 4 },
    eligibleDueJobs: 2,
    admissionHorizon: 10,
    campaigns: [],
    inboundEnabled: false,
    inboundWarmFloor: 2,
    configuredMax: 20,
    carrierConcurrency: 20,
    providerConcurrency: 20,
    spendPermitted: 20,
    provisionedTasks: 4,
    oldestEligibleJobAgeSeconds: 3,
  };
}

describe('dispatcher loop', () => {
  afterEach(() => vi.useRealTimers());

  it('publishes no signal for stale input or a failed DescribeServices read and degrades health', async () => {
    const publish = vi.fn(async () => undefined);
    const stale = new DispatcherLoop({
      tasks: [],
      readCapacityInput: async () => ({ ...capacity(), observedAtMs: Date.now() - 20_000 }),
      publish,
    });
    await stale.capacityTick();
    expect(publish).not.toHaveBeenCalled();
    expect(stale.health()).toMatchObject({
      healthy: false,
      detail: 'capacity input stale or inconsistent',
    });
    const failedDescribe = new DispatcherLoop({
      tasks: [],
      readCapacityInput: async () => {
        throw new Error('DescribeServices unavailable');
      },
      publish,
    });
    await failedDescribe.capacityTick();
    expect(publish).not.toHaveBeenCalled();
    expect(failedDescribe.health()).toMatchObject({
      healthy: false,
      detail: 'capacity:Error: DescribeServices unavailable',
    });
  });

  it('publishes the computed capacity signal from each independent replica', async () => {
    const first = vi.fn(async (_signal: unknown) => undefined);
    const second = vi.fn(async (_signal: unknown) => undefined);
    for (const publish of [first, second]) {
      const loop = new DispatcherLoop({
        tasks: [],
        readCapacityInput: async () => capacity(1_000_000),
        publish,
      });
      await loop.capacityTick();
      expect(loop.health()).toMatchObject({ healthy: true });
    }
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]![0]).toMatchObject({
      provisionedTasks: 4,
      busySlots: 2,
      readyIdleSlots: 2,
      eligibleJobs: 2,
    });
    expect(second.mock.calls[0]![0]).toEqual(first.mock.calls[0]![0]);
  });

  it('runs every installed task with jitter, isolates failures, and aborts on stop', async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    const ticks: string[] = [];
    const first = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      ticks.push('first');
      if (ticks.filter((item) => item === 'first').length === 1) throw new Error('transient');
    });
    const second = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      ticks.push('second');
    });
    const loop = new DispatcherLoop({
      tasks: [
        { id: 'one', intervalMs: 100, jitterMs: 10, tick: first },
        { id: 'two', intervalMs: 100, jitterMs: 10, tick: second },
      ],
      readCapacityInput: async () => capacity(),
      publish: async () => undefined,
      random: () => 0.5,
      log,
    });
    loop.start();
    await vi.advanceTimersByTimeAsync(5);
    expect(ticks).toEqual(['first', 'second']);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'background_task_failed', taskId: 'one' }),
    );
    await vi.advanceTimersByTimeAsync(105);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    await loop.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('reports inbound readiness on health, logs only changes, and keeps signalling when it fails', async () => {
    const publish = vi.fn(async () => undefined);
    const log = vi.fn();
    const readiness = {
      admissionEnabled: false,
      readyWorkers: 2,
      readyProtected: 0,
      warmFloor: 2,
      ready: true,
      reasons: ['OVO_INBOUND_ENABLED=false'],
    };
    const readInboundReadiness = vi
      .fn()
      .mockResolvedValueOnce(readiness)
      .mockResolvedValueOnce(readiness)
      .mockRejectedValueOnce(new Error('operations unavailable'));
    const loop = new DispatcherLoop({
      tasks: [],
      readCapacityInput: async () => capacity(),
      publish,
      readInboundReadiness,
      log,
    });
    await loop.capacityTick();
    await loop.capacityTick();
    expect(readInboundReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ inboundWarmFloor: 2 }),
    );
    expect(loop.health()).toMatchObject({ healthy: true, inbound: readiness });
    expect(log.mock.calls.filter(([entry]) => entry.event === 'inbound_readiness')).toEqual([
      [{ event: 'inbound_readiness', ...readiness }],
    ]);
    await loop.capacityTick();
    expect(publish).toHaveBeenCalledTimes(3);
    expect(loop.health()).toMatchObject({ healthy: true, inbound: undefined });
    expect(log).toHaveBeenCalledWith({
      event: 'inbound_readiness_failed',
      error: 'Error: operations unavailable',
    });
  });
});
