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

  it('allows independent replicas to publish identical demand', async () => {
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
    expect(first.mock.calls[0]?.[0]).toEqual(second.mock.calls[0]?.[0]);
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
});
