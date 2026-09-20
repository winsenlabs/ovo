import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EcsDesiredCountWriter,
  StaleCapacityAuthorityError,
  UnresolvedCapacityWriteError,
  UncertainCapacityWriteError,
  type EcsServiceApi,
} from '../src/aws.ts';
import { PostgresOrchestrationStore } from '../src/postgres.ts';

class FakeEcsApi implements EcsServiceApi {
  updates: number[] = [];
  desiredCount = 0;
  updateEffect?: (desiredCount: number) => Promise<void>;

  async update(input: { desiredCount: number }): Promise<void> {
    this.updates.push(input.desiredCount);
    if (this.updateEffect) await this.updateEffect(input.desiredCount);
    this.desiredCount = input.desiredCount;
  }

  async describe() {
    return { desiredCount: this.desiredCount, runningCount: 0, pendingCount: 0 };
  }
}

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)('PostgreSQL-fenced ECS desired-count writes', () => {
  let store: PostgresOrchestrationStore;
  const serviceKeys: string[] = [];

  beforeAll(async () => {
    store = new PostgresOrchestrationStore({ connectionString: postgresUrl });
    await store.migrate();
  });

  afterAll(async () => {
    if (!store) return;
    await store.pool.query('DELETE FROM ovo_capacity_writes WHERE service_key = ANY($1::text[])', [
      serviceKeys,
    ]);
    await store.pool.query('DELETE FROM ovo_capacity_leases WHERE service_key = ANY($1::text[])', [
      serviceKeys,
    ]);
    await store.close();
  });

  function key(): string {
    const value = `workers-${randomUUID()}`;
    serviceKeys.push(value);
    return value;
  }

  function writer(authorityId: string, serviceKey: string, api: FakeEcsApi) {
    return new EcsDesiredCountWriter(
      authorityId,
      'test-cluster',
      { [serviceKey]: 'test-service' },
      store,
      { region: 'ap-south-1' },
      api,
    );
  }

  it('rejects a stale authority and epoch before invoking the AWS adapter', async () => {
    const serviceKey = key();
    const first = await store.acquire(serviceKey, 'dispatcher-a', 60_000);
    expect(first).toEqual({ epoch: 1 });
    await store.pool.query(
      `UPDATE ovo_capacity_leases SET lease_expires_at = now() - interval '1 second' WHERE service_key = $1`,
      [serviceKey],
    );
    const second = await store.acquire(serviceKey, 'dispatcher-b', 60_000);
    expect(second).toEqual({ epoch: 2 });
    const api = new FakeEcsApi();
    await expect(
      writer('dispatcher-a', serviceKey, api).write(serviceKey, 3, first!.epoch),
    ).rejects.toBeInstanceOf(StaleCapacityAuthorityError);
    expect(api.updates).toEqual([]);
  });

  it('blocks a new leader while the old leader write is inflight across lease expiry', async () => {
    const serviceKey = key();
    const first = await store.acquire(serviceKey, 'dispatcher-a', 60_000);
    let releaseUpdate!: () => void;
    let updateStarted!: () => void;
    const started = new Promise<void>((resolve) => (updateStarted = resolve));
    const blocked = new Promise<void>((resolve) => (releaseUpdate = resolve));
    const oldApi = new FakeEcsApi();
    oldApi.updateEffect = async () => {
      updateStarted();
      await blocked;
    };
    const oldWrite = writer('dispatcher-a', serviceKey, oldApi).write(serviceKey, 4, first!.epoch);
    await started;

    await store.pool.query(
      `UPDATE ovo_capacity_leases SET lease_expires_at = now() - interval '1 second' WHERE service_key = $1`,
      [serviceKey],
    );
    const second = await store.acquire(serviceKey, 'dispatcher-b', 60_000);
    const newApi = new FakeEcsApi();
    const newWriter = writer('dispatcher-b', serviceKey, newApi);
    newApi.desiredCount = 4;
    expect(await newWriter.reconcile(serviceKey)).toBe(false);
    await expect(newWriter.write(serviceKey, 5, second!.epoch)).rejects.toBeInstanceOf(
      UnresolvedCapacityWriteError,
    );
    expect(newApi.updates).toEqual([]);

    releaseUpdate();
    await oldWrite;
    await newWriter.write(serviceKey, 5, second!.epoch);
    expect(oldApi.updates).toEqual([4]);
    expect(newApi.updates).toEqual([5]);
  });

  it('does not release an uncertain AWS outcome when desired-count readback matches', async () => {
    const serviceKey = key();
    const first = await store.acquire(serviceKey, 'dispatcher-a', 60_000);
    const oldApi = new FakeEcsApi();
    oldApi.updateEffect = async () => {
      throw new Error('connection reset after request write');
    };
    await expect(
      writer('dispatcher-a', serviceKey, oldApi).write(serviceKey, 6, first!.epoch),
    ).rejects.toBeInstanceOf(UncertainCapacityWriteError);

    await store.pool.query(
      `UPDATE ovo_capacity_leases SET lease_expires_at = now() - interval '1 second' WHERE service_key = $1`,
      [serviceKey],
    );
    const second = await store.acquire(serviceKey, 'dispatcher-b', 60_000);
    const newApi = new FakeEcsApi();
    const newWriter = writer('dispatcher-b', serviceKey, newApi);
    expect(await newWriter.reconcile(serviceKey)).toBe(false);
    await expect(newWriter.write(serviceKey, 7, second!.epoch)).rejects.toBeInstanceOf(
      UnresolvedCapacityWriteError,
    );
    expect(newApi.updates).toEqual([]);

    newApi.desiredCount = 6;
    expect(await newWriter.reconcile(serviceKey)).toBe(false);
    await expect(newWriter.write(serviceKey, 7, second!.epoch)).rejects.toBeInstanceOf(
      UnresolvedCapacityWriteError,
    );
    expect(newApi.updates).toEqual([]);

    const unresolved = await store.pending(serviceKey);
    expect(unresolved).toMatchObject({ desiredCount: 6, status: 'unknown' });
  });
});
