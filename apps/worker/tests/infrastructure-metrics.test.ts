import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerInfrastructureMetrics } from '../src/infrastructure-metrics.ts';
import { WorkerRunner } from '../src/index.ts';
import { PostgresOrchestrationStore, type DurableQueue } from '@winsendotai/ovo-plugin-orchestration';

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

describe.skipIf(!process.env.OVO_TEST_POSTGRES_URL)('worker durable hint liveness', () => {
  it.each([
    ['handle', 'not_before'], ['handle', 'currently_leased'],
    ['defer', 'not_before'], ['defer', 'currently_leased'],
  ] as const)('clears the durable hint before deleting a %s %s receipt', async (entry, reason) => {
    const store = new PostgresOrchestrationStore({
      connectionString: process.env.OVO_TEST_POSTGRES_URL,
    });
    await store.migrate();
    const jobId = randomUUID();
    let deleted = 0;
    let visibilityChanges = 0;
    const queue: DurableQueue = {
      async send() { throw new Error('unexpected send'); },
      async receive() { return []; },
      async delete() { deleted += 1; },
      async changeVisibility() { visibilityChanges += 1; },
    };
    try {
      await store.enqueue({ id: jobId, workspaceId: `hint-${jobId}`, idempotencyKey: jobId,
        payload: {}, notBefore: reason === 'not_before'
          ? new Date(Date.now() + 60_000) : undefined });
      if (reason === 'currently_leased')
        expect((await store.claim(jobId, 'first-worker', 60_000)).kind).toBe('execute');
      await store.pool.query('UPDATE ovo_jobs SET hinted_at=now() WHERE id=$1', [jobId]);
      const worker = new WorkerRunner('second-worker', store, queue,
        { async check() { return { ready: true as const }; } }, {} as never, {} as never);
      const receipt = { messageId: jobId, receiptHandle: jobId, receiveCount: 1,
        reference: { schemaVersion: 1 as const, jobId } };
      const outcome = entry === 'handle' ? await worker.handle(receipt)
        : await worker.defer(receipt, 'worker-draining');
      expect(outcome.kind).toBe('deferred');
      expect([deleted, visibilityChanges]).toEqual([1, 0]);
      const row = (await store.pool.query<{ hinted_at: Date | null; owner_id: string | null }>(
        'SELECT hinted_at,owner_id FROM ovo_jobs WHERE id=$1', [jobId],
      )).rows[0]!;
      expect(row.hinted_at).toBeNull();
      expect(row.owner_id).toBe(reason === 'currently_leased' ? 'first-worker' : null);
    } finally {
      await store.pool.query('DELETE FROM ovo_outbox WHERE aggregate_id=$1', [jobId]);
      await store.pool.query('DELETE FROM ovo_jobs WHERE id=$1', [jobId]);
      await store.close();
    }
  });
});
