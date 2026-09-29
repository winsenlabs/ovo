import { randomUUID } from 'node:crypto';
import type { CarrierControlFactory } from '@winsendotai/ovo-contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignDriver } from '../src/campaign-driver.ts';
import { PostgresOperationsService } from '../src/service.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;
const signal = new AbortController().signal;

integration('campaign driver on durable Postgres rows', () => {
  const schema = `o2_driver_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let sequence = 0;
  const number = '+14155550000';
  const factory = (cps: number) =>
    ({
      capabilities: {
        carrierId: 'carrier-fixture',
        pacing: { cps },
      },
    }) as CarrierControlFactory;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 5 });
    await new PostgresOperationsService({
      pool,
      organizationId: `o2-setup-${randomUUID()}`,
    }).migrate();
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  async function setup(
    input: {
      contacts?: number;
      maxConcurrency?: number;
      cps?: number;
      ready?: number;
      queued?: number;
      carrier?: string | null;
      organizationId?: string;
    } = {},
  ) {
    const organizationId = input.organizationId ?? `o2-driver-${randomUUID()}`;
    const service = new PostgresOperationsService({ pool, organizationId });
    const campaign = await service.campaigns.create(
      {
        operationId: randomUUID(),
        name: 'CSV import',
        agentReleaseId: randomUUID(),
        fromNumber: number,
        schedule: { localDateTime: '2000-01-01T00:00', timezone: 'UTC' },
        perNumberAttemptLimit: 3,
        maxAttemptsTotal: 100,
        maxAttemptsPerLocalDay: 100,
        activeCallPolicy: 'continue',
        maxConcurrency: input.maxConcurrency ?? 3,
        ...(input.carrier === null
          ? {}
          : {
              carrierPluginId: 'carrier.fixture',
              carrierId: input.carrier ?? 'carrier-fixture',
              carrierBindingId: null,
              bindingCps: input.cps ?? null,
            }),
      },
      Array.from({ length: input.contacts ?? 3 }, (_, index) => ({
        sourceRow: index + 1,
        phoneNumber: `+1415555${String(++sequence).padStart(4, '0')}`,
        variables: {},
      })),
    );
    const capacity = {
      admissionSnapshot: async () => ({
        readyIdleSlots: input.ready ?? 10,
        eligibleQueuedJobs: input.queued ?? 0,
      }),
    };
    const controls = new Map([['carrier-fixture', factory(2)]]);
    const driver = new CampaignDriver(pool, organizationId, capacity, controls);
    return { service, campaign, driver, controls, organizationId };
  }

  async function contacts(campaignId: string) {
    return (
      await pool.query<{ id: string; state: string; owner_epoch: string }>(
        'SELECT id,state,owner_epoch FROM ovo_ops_campaign_contacts WHERE campaign_id=$1 ORDER BY source_row',
        [campaignId],
      )
    ).rows;
  }

  it('admits only min(concurrency, ready minus queued, persisted tokens)', async () => {
    const { campaign, driver } = await setup({
      contacts: 4,
      maxConcurrency: 4,
      ready: 4,
      queued: 1,
    });
    expect(await driver.tick(signal)).toBe(2);
    expect((await contacts(campaign.id)).filter((row) => row.state === 'admitted')).toHaveLength(2);
    expect(await driver.tick(signal)).toBe(0); // Two undelivered candidates consume two slots.
  });

  it('holds ready slots for campaign candidates until the outbox dispatches them', async () => {
    const { campaign, driver } = await setup({
      contacts: 4,
      maxConcurrency: 4,
      ready: 4,
      queued: 1,
      cps: 4,
    });
    expect(await driver.tick(signal)).toBe(3);
    expect(await driver.tick(signal)).toBe(0);
    expect((await contacts(campaign.id)).filter((row) => row.state === 'admitted')).toHaveLength(3);
  });

  it('does not admit with zero ready slots or without the organization advisory lock', async () => {
    const zero = await setup({ ready: 0 });
    expect(await zero.driver.tick(signal)).toBe(0);
    expect((await contacts(zero.campaign.id))[0]?.state).toBe('queued');
    const locked = await setup();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('ovo-campaign-driver:' || $1))", [
        locked.organizationId,
      ]);
      expect(await locked.driver.tick(signal)).toBe(0);
      expect((await contacts(locked.campaign.id))[0]?.state).toBe('queued');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('requeues expired admission before measuring concurrency and bumps its epoch', async () => {
    const { campaign, driver, service } = await setup({ contacts: 1, maxConcurrency: 1, ready: 1 });
    const first = await service.campaigns.admit(campaign.id, 'old-worker', 1_000);
    if (first.kind !== 'admitted') throw new Error('first admission missing');
    await pool.query(
      "UPDATE ovo_ops_campaign_contacts SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [first.contactId],
    );
    expect(await driver.tick(signal)).toBe(1);
    expect((await contacts(campaign.id))[0]?.owner_epoch).toBe('2');
  });

  it('keeps a connected call inside maxConcurrency and unknown attempts nonterminal', async () => {
    const { campaign, driver, service } = await setup({ contacts: 2, maxConcurrency: 1 });
    const first = await service.campaigns.admit(campaign.id, 'worker', 60_000);
    if (first.kind !== 'admitted') throw new Error('first admission missing');
    const authorized = await service.campaigns.authorizeDial(
      first.contactId,
      'worker',
      first.ownerEpoch,
    );
    if (authorized.kind !== 'authorized') throw new Error('authorization missing');
    await pool.query('UPDATE ovo_ops_outbox SET sent_at=now() WHERE aggregate_id=$1', [
      first.jobId,
    ]);
    await service.campaigns.recordAttempt(
      authorized.attemptId,
      randomUUID(),
      'connected',
      new Date(),
    );
    expect(await driver.tick(signal)).toBe(0);
    expect((await contacts(campaign.id)).filter((row) => row.state === 'queued')).toHaveLength(1);
    await service.campaigns.recordAttempt(
      authorized.attemptId,
      randomUUID(),
      'unknown',
      new Date(),
    );
    expect((await service.campaigns.counters(campaign.id)).attempts.reconciling).toBe(1);
    expect(await driver.tick(signal)).toBe(0);
    expect((await service.campaigns.get(campaign.id)).status).toBe('running');
  });

  it('isolates a legacy missing-carrier campaign and keeps healthy imports progressing', async () => {
    const organizationId = `o2-mixed-${randomUUID()}`;
    const old = await setup({ organizationId, contacts: 1, carrier: null });
    const removed = await setup({ organizationId, contacts: 1, carrier: 'missing-carrier' });
    const healthy = await setup({ organizationId, contacts: 1 });
    expect(await healthy.driver.tick(signal)).toBe(1);
    expect((await old.service.campaigns.get(old.campaign.id)).driverError).toBe(
      'Campaign has no carrier snapshot',
    );
    expect((await removed.service.campaigns.get(removed.campaign.id)).driverError).toBe(
      'Campaign carrier missing-carrier is missing or ambiguous',
    );
    expect((await contacts(healthy.campaign.id))[0]?.state).toBe('admitted');
  });

  it('rolls back admission and token debit together if bucket update fails', async () => {
    const { campaign, driver, organizationId } = await setup({ contacts: 1, cps: 1 });
    const trigger = `o2_rollback_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.organization_id = '${organizationId}' THEN
        RAISE EXCEPTION 'forced pacing failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON ovo_ops_pacing_buckets
      FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      await expect(driver.tick(signal)).rejects.toThrow('forced pacing failure');
      expect((await contacts(campaign.id))[0]?.state).toBe('queued');
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM ovo_ops_outbox WHERE dedup_key LIKE $1',
            [`${campaign.id}:%`],
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM ovo_ops_pacing_buckets WHERE organization_id=$1',
            [organizationId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON ovo_ops_pacing_buckets`);
      await pool.query(`DROP FUNCTION ${trigger}()`);
    }
  });

  it('completes a drained campaign only after its attempt has a definitive result', async () => {
    const { campaign, driver, service } = await setup({ contacts: 1 });
    const admission = await service.campaigns.admit(campaign.id, 'worker', 60_000);
    if (admission.kind !== 'admitted') throw new Error('admission missing');
    const dial = await service.campaigns.authorizeDial(
      admission.contactId,
      'worker',
      admission.ownerEpoch,
    );
    if (dial.kind !== 'authorized') throw new Error('authorization missing');
    await service.campaigns.recordAttempt(dial.attemptId, randomUUID(), 'unknown', new Date());
    expect(await driver.tick(signal)).toBe(0);
    expect((await service.campaigns.get(campaign.id)).status).toBe('running');
    await service.campaigns.recordAttempt(dial.attemptId, randomUUID(), 'succeeded', new Date());
    expect(await driver.tick(signal)).toBe(0);
    expect((await service.campaigns.get(campaign.id)).status).toBe('completed');
  });

  it('neutralizes a late callback from an older admission epoch', async () => {
    const { campaign, service } = await setup({ contacts: 1 });
    const old = await service.campaigns.admit(campaign.id, 'worker-old', 60_000);
    if (old.kind !== 'admitted') throw new Error('old admission missing');
    const prior = await service.campaigns.authorizeDial(
      old.contactId,
      'worker-old',
      old.ownerEpoch,
    );
    if (prior.kind !== 'authorized') throw new Error('old authorization missing');
    await pool.query(
      `UPDATE ovo_ops_campaign_contacts SET state='queued',owner_id=NULL,
      lease_expires_at=NULL WHERE id=$1`,
      [old.contactId],
    );
    const fresh = await service.campaigns.admit(campaign.id, 'worker-new', 60_000);
    if (fresh.kind !== 'admitted') throw new Error('new admission missing');
    const current = await service.campaigns.authorizeDial(
      fresh.contactId,
      'worker-new',
      fresh.ownerEpoch,
    );
    if (current.kind !== 'authorized') throw new Error('new authorization missing');
    expect(
      await service.campaigns.recordAttempt(prior.attemptId, randomUUID(), 'succeeded', new Date()),
    ).toBe('ignored_terminal');
    expect((await contacts(campaign.id))[0]?.state).toBe('dialing');
    expect(
      (await pool.query('SELECT status FROM ovo_ops_attempts WHERE id=$1', [prior.attemptId]))
        .rows[0],
    ).toEqual({ status: 'superseded' });
  });

  it('keeps env-binding pacing tokens separate between organizations', async () => {
    const left = await setup({ contacts: 1, cps: 1 });
    const right = await setup({ contacts: 1, cps: 1 });
    expect(await left.driver.tick(signal)).toBe(1);
    expect(await right.driver.tick(signal)).toBe(1);
    const rows = await pool.query(
      `SELECT organization_id FROM ovo_ops_pacing_buckets WHERE carrier_id='carrier-fixture'
       AND binding_id IS NULL AND from_number=$1 AND organization_id=ANY($2::text[])`,
      [number, [left.organizationId, right.organizationId]],
    );
    expect(rows.rowCount).toBe(2);
  });

  it('refills a fractional CPS bucket to one token', async () => {
    const { campaign, driver, organizationId } = await setup({ contacts: 1, cps: 0.5 });
    await pool.query(
      `INSERT INTO ovo_ops_pacing_buckets
      (organization_id,carrier_id,binding_id,from_number,tokens,refilled_at)
      VALUES($1,'carrier-fixture',NULL,$2,0,now()-interval '3 seconds')`,
      [organizationId, number],
    );
    expect(await driver.tick(signal)).toBe(1);
    expect((await contacts(campaign.id))[0]?.state).toBe('admitted');
  });

  it('patches concurrency without invalidating an already admitted contact', async () => {
    const { campaign, service } = await setup({ contacts: 2, maxConcurrency: 1 });
    const first = await service.campaigns.admit(campaign.id, 'worker', 60_000);
    if (first.kind !== 'admitted') throw new Error('first admission missing');
    const patch = await service.campaigns.patchConcurrency(campaign.id, campaign.version, 2);
    expect(patch.kind).toBe('applied');
    expect(
      await service.campaigns.authorizeDial(first.contactId, 'worker', first.ownerEpoch),
    ).toMatchObject({ kind: 'authorized' });
    expect((await contacts(campaign.id))[0]?.state).toBe('dialing');
  });

  it('accepts an old operationId retry after adding the default concurrency and carrier snapshot', async () => {
    const organizationId = `o2-legacy-idempotency-${randomUUID()}`;
    const service = new PostgresOperationsService({ pool, organizationId });
    const config = {
      operationId: randomUUID(),
      name: 'Old campaign',
      agentReleaseId: randomUUID(),
      fromNumber: number,
      schedule: { localDateTime: '2000-01-01T00:00', timezone: 'UTC' },
      perNumberAttemptLimit: 1,
      maxAttemptsTotal: 1,
      maxAttemptsPerLocalDay: 1,
      activeCallPolicy: 'continue' as const,
    };
    const list = [
      {
        sourceRow: 1,
        phoneNumber: `+1415555${String(++sequence).padStart(4, '0')}`,
        variables: {},
      },
    ];
    const old = await service.campaigns.create(config, list);
    const retry = await service.campaigns.create(
      {
        ...config,
        maxConcurrency: 1,
        carrierPluginId: 'carrier.fixture',
        carrierId: 'carrier-fixture',
        carrierBindingId: null,
        bindingCps: null,
      },
      list,
    );
    expect(retry.id).toBe(old.id);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM ovo_ops_campaigns WHERE operation_id=$1', [
          config.operationId,
        ])
      ).rows[0]?.n,
    ).toBe(1);
  });
});
