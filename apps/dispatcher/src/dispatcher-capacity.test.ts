import { describe, expect, it, vi } from 'vitest';
import { computeCapacitySignal } from '@winsendotai/ovo-plugin-orchestration';
import { readDispatcherCapacityInput } from './dispatcher-capacity.ts';

function ports() {
  const store = {
    readCapacitySnapshot: vi.fn(async () => ({
      observedAtMs: 1_000_000,
      counts: { readyIdle: 2, reserved: 0, active: 0, starting: 0, draining: 0, total: 2 },
      eligibleUnclaimed: 0,
      oldestEligibleJobAgeSeconds: 0,
    })),
  };
  const operations = {
    organizationId: 'one-org',
    pool: {
      query: vi.fn(async (sql: string): Promise<{ rows: Record<string, unknown>[] }> => {
        if (sql.includes('information_schema.columns')) return { rows: [{ present: false }] };
        return { rows: [{ count: '0' }] };
      }),
    },
  };
  return { store, operations };
}

describe('dispatcher capacity input', () => {
  it('counts a provisioned task missing from the worker snapshot as starting', async () => {
    const { store, operations } = ports();
    const input = await readDispatcherCapacityInput({
      store: store as never,
      operations: operations as never,
      env: {},
      readProvisionedTasks: async () => 3,
      nowMs: () => 1_001_000,
    });
    expect(input.counts).toMatchObject({ readyIdle: 2, starting: 1, total: 3 });
    expect(computeCapacitySignal(input)).toMatchObject({ provisionedTasks: 3 });
  });

  it('accepts a fresh database snapshot when the database clock leads the app clock', async () => {
    const { store, operations } = ports();
    const input = await readDispatcherCapacityInput({
      store: store as never,
      operations: operations as never,
      env: {},
      readProvisionedTasks: async () => 2,
      nowMs: () => 999_930,
    });
    expect(input.nowMs).toBe(1_000_000);
    expect(computeCapacitySignal(input)).toBeDefined();
    const stale = { ...input, nowMs: 1_020_000 };
    expect(computeCapacitySignal(stale)).toBeUndefined();
  });

  it('does not add the warm floor when inbound is disabled, even if the floor is positive', async () => {
    const { store, operations } = ports();
    const base = {
      store: store as never,
      operations: operations as never,
      readProvisionedTasks: async () => 2,
      nowMs: () => 1_001_000,
    };
    const disabled = await readDispatcherCapacityInput({
      ...base,
      env: {
        OVO_INBOUND_ENABLED: 'false',
        OVO_INBOUND_WARM_FLOOR: '2',
      },
    });
    const enabled = await readDispatcherCapacityInput({
      ...base,
      env: {
        OVO_INBOUND_ENABLED: 'true',
        OVO_INBOUND_WARM_FLOOR: '2',
      },
    });
    expect(computeCapacitySignal(disabled)?.requiredSlots).toBe(0);
    expect(computeCapacitySignal(enabled)?.requiredSlots).toBe(2);
  });

  it('fails closed when pre-O2 campaign rows lack max_concurrency', async () => {
    const { store, operations } = ports();
    operations.pool.query.mockResolvedValueOnce({ rows: [{ present: false }] });
    operations.pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    await expect(
      readDispatcherCapacityInput({
        store: store as never,
        operations: operations as never,
        env: {},
        readProvisionedTasks: async () => 2,
      }),
    ).rejects.toThrow('Campaign capacity requires the max_concurrency migration');
  });

  it('feeds running demand and scheduled prewarm from durable campaign rows', async () => {
    const { store, operations } = ports();
    operations.pool.query.mockResolvedValueOnce({ rows: [{ present: true }] });
    operations.pool.query.mockResolvedValueOnce({
      rows: [
        {
          status: 'running',
          schedule_at: new Date(999_000),
          max_concurrency: 3,
          due_queued: '5',
          admitted: '1',
          contacts: '5',
        },
        {
          status: 'scheduled',
          schedule_at: new Date(1_001_000 + 60_000),
          max_concurrency: 2,
          due_queued: '0',
          admitted: '0',
          contacts: '4',
        },
      ],
    });
    const input = await readDispatcherCapacityInput({
      store: store as never,
      operations: operations as never,
      env: { OVO_INBOUND_ENABLED: 'false' },
      readProvisionedTasks: async () => 2,
      nowMs: () => 1_001_000,
    });
    expect(input.campaigns).toHaveLength(2);
    expect(computeCapacitySignal(input)).toMatchObject({
      campaignDemand: 2,
      requiredSlots: 4,
    });
  });

  it('allows demand above 100 only when all three quotas permit it', async () => {
    const { store, operations } = ports();
    store.readCapacitySnapshot.mockResolvedValue({
      observedAtMs: 1_000_000,
      counts: { readyIdle: 0, reserved: 0, active: 0, starting: 0, draining: 0, total: 0 },
      eligibleUnclaimed: 150,
      oldestEligibleJobAgeSeconds: 0,
    });
    const input = await readDispatcherCapacityInput({
      store: store as never,
      operations: operations as never,
      env: {
        OVO_WORKER_MAX_CAPACITY: '200',
        OVO_PERMITTED_STARTS: '200',
        OVO_CARRIER_CONCURRENCY: '200',
        OVO_PROVIDER_CONCURRENCY: '200',
        OVO_SPEND_PERMITTED_STARTS: '200',
      },
      readProvisionedTasks: async () => 0,
      nowMs: () => 1_001_000,
    });
    expect(computeCapacitySignal(input)?.requiredSlots).toBe(150);
    expect(computeCapacitySignal({ ...input, carrierConcurrency: 100 })?.requiredSlots).toBe(100);
    const defaults = await readDispatcherCapacityInput({
      store: store as never,
      operations: operations as never,
      env: { OVO_WORKER_MAX_CAPACITY: '200', OVO_PERMITTED_STARTS: '200' },
      readProvisionedTasks: async () => 0,
      nowMs: () => 1_001_000,
    });
    expect([
      defaults.carrierConcurrency,
      defaults.providerConcurrency,
      defaults.spendPermitted,
    ]).toEqual([100, 100, 100]);
    expect(computeCapacitySignal(defaults)?.requiredSlots).toBe(100);
  });
});
