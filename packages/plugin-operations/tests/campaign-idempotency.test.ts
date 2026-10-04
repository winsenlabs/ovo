import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresOperationsService } from '../src/service.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!databaseUrl)('campaign create idempotency on Postgres', () => {
  const schema = `o2_campaign_idempotency_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await new PostgresOperationsService({
      pool,
      organizationId: `setup-${randomUUID()}`,
    }).migrate();
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('accepts a legacy retry with default concurrency but rejects a new carrier selection', async () => {
    const service = new PostgresOperationsService({
      pool,
      organizationId: `o2-legacy-idempotency-${randomUUID()}`,
    });
    const config = {
      operationId: randomUUID(),
      name: 'Old campaign',
      agentReleaseId: randomUUID(),
      fromNumber: '+14155550000',
      schedule: { localDateTime: '2000-01-01T00:00', timezone: 'UTC' },
      perNumberAttemptLimit: 1,
      maxAttemptsTotal: 1,
      maxAttemptsPerLocalDay: 1,
      activeCallPolicy: 'continue' as const,
    };
    const list = [{ sourceRow: 1, phoneNumber: '+14155550001', variables: {} }];
    const old = await service.campaigns.create(config, list);
    const retry = await service.campaigns.create({ ...config, maxConcurrency: 1 }, list);
    expect(retry.id).toBe(old.id);
    await expect(
      service.campaigns.create(
        {
          ...config,
          maxConcurrency: 1,
          carrierPluginId: 'carrier.fixture',
          carrierId: 'carrier-fixture',
          carrierBindingId: null,
          bindingCps: null,
        },
        list,
      ),
    ).rejects.toThrow('Campaign operationId collision');
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n, max(carrier_id) AS carrier_id FROM ovo_ops_campaigns WHERE operation_id=$1',
          [config.operationId],
        )
      ).rows[0],
    ).toEqual({ n: 1, carrier_id: null });
  });
});
