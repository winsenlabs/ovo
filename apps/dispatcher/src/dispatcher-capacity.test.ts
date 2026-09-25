import { describe, expect, it, vi } from 'vitest';
import { computeCapacitySignal } from '@winsendotai/ovo-plugin-orchestration';
import { readDispatcherCapacityInput } from './dispatcher-capacity.ts';

function ports() {
  const store = { readCapacitySnapshot: vi.fn(async () => ({
    observedAtMs: 1_000_000,
    counts: { readyIdle: 2, reserved: 0, active: 0, starting: 0, draining: 0, total: 2 },
    eligibleUnclaimed: 0, oldestEligibleJobAgeSeconds: 0,
  })) };
  const operations = { organizationId: 'one-org', pool: { query: vi.fn(async (sql: string) => {
    if (sql.includes('information_schema.columns')) return { rows: [{ present: false }] };
    return { rows: [{ count: '0' }] };
  }) } };
  return { store, operations };
}

describe('dispatcher capacity input', () => {
  it('does not add the warm floor when inbound is disabled, even if the floor is positive', async () => {
    const { store, operations } = ports();
    const base = { store: store as never, operations: operations as never,
      readProvisionedTasks: async () => 2, nowMs: () => 1_001_000 };
    const disabled = await readDispatcherCapacityInput({ ...base, env: {
      OVO_INBOUND_ENABLED: 'false', OVO_INBOUND_WARM_FLOOR: '2',
    } });
    const enabled = await readDispatcherCapacityInput({ ...base, env: {
      OVO_INBOUND_ENABLED: 'true', OVO_INBOUND_WARM_FLOOR: '2',
    } });
    expect(computeCapacitySignal(disabled)?.requiredSlots).toBe(0);
    expect(computeCapacitySignal(enabled)?.requiredSlots).toBe(2);
  });

  it('fails closed when pre-O2 campaign rows lack max_concurrency', async () => {
    const { store, operations } = ports();
    operations.pool.query.mockResolvedValueOnce({ rows: [{ present: false }] });
    operations.pool.query.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    await expect(readDispatcherCapacityInput({ store: store as never,
      operations: operations as never, env: {}, readProvisionedTasks: async () => 2,
    })).rejects.toThrow('Campaign capacity requires the max_concurrency migration');
  });
});
