import { describe, expect, it } from 'vitest';
import { WorkerInfrastructureMetrics } from '../src/infrastructure-metrics.ts';

describe('worker infrastructure heartbeat metrics', () => {
  it('reports real process measurements and leaves unavailable platform values null', () => {
    const metrics = new WorkerInfrastructureMetrics();
    const snapshot = metrics.snapshot();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.process.cpuPercent).toEqual(expect.any(Number));
    expect(snapshot.process.memoryRssBytes).toBeGreaterThan(0);
    expect(snapshot.process.restartCount).toBeNull();
    expect(snapshot.process.memoryLimitBytes).toBeNull();
    expect(snapshot.providerQuotas).toEqual([]);
    expect(snapshot.throttling).toEqual([]);
    metrics.close();
  });

  it('publishes only explicitly observed quota and throttling evidence', () => {
    const metrics = new WorkerInfrastructureMetrics({ restartCount: 2, memoryLimitBytes: 1024 });
    metrics.updateQuota({
      provider: 'carrier',
      metric: 'concurrent-calls',
      limit: 20,
      remaining: 7,
      resetAt: '2026-09-20T17:00:00.000Z',
    });
    metrics.recordThrottle('carrier', new Date('2026-09-20T16:00:00.000Z'));
    metrics.recordThrottle('carrier', new Date('2026-09-20T16:01:00.000Z'));
    metrics.clearThrottle('carrier');
    const snapshot = metrics.snapshot();
    expect(snapshot.process).toMatchObject({ restartCount: 2, memoryLimitBytes: 1024 });
    expect(snapshot.providerQuotas).toEqual([
      expect.objectContaining({ provider: 'carrier', limit: 20, remaining: 7 }),
    ]);
    expect(snapshot.throttling).toEqual([
      {
        provider: 'carrier',
        active: false,
        count: 2,
        lastAt: '2026-09-20T16:01:00.000Z',
      },
    ]);
    metrics.close();
  });
});
