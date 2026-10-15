import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import migration001 from '../migrations/001_cost_ledger.sql?raw';
import migration002 from '../migrations/002_reservation_expiry.sql?raw';
import migration003 from '../migrations/003_price_card_model.sql?raw';
import migration004 from '../migrations/004_exact_charge_amount.sql?raw';
import { PostgresCostLedger, type PriceCardVersion, type RecordUsageInput } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

/** Wave 16 (ledger 005): usage tagged by the segment of a routed call that metered it. */
describe.skipIf(!postgresUrl)('usage by call segment on the PostgreSQL ledger', () => {
  const schema = `cost_segment_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let ledger: PostgresCostLedger;
  const card: PriceCardVersion = {
    id: 'stt-inr',
    version: 'v1',
    provider: 'fixture-stt',
    unit: 'seconds',
    currency: 'INR',
    minorUnitsPerBlock: '10',
    blockQuantity: '3',
    effectiveAt: '2026-09-20T00:00:00.000Z',
    provenance: 'fixture price publication',
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    // A ledger as Wave 15 left it: migrations 001-004 and one usage row without a segment.
    for (const sql of [migration001, migration002, migration003, migration004])
      await pool.query(sql);
    await pool.query('INSERT INTO ovo_cost_schema_migrations(version) VALUES (2), (3), (4)');
    ledger = new PostgresCostLedger(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  function usage(overrides: Partial<RecordUsageInput> = {}): RecordUsageInput {
    const id = randomUUID();
    return {
      idempotencyKey: `usage-${id}`,
      workspaceId: 'ws',
      sessionId: 'media-1',
      callId: 'call-1',
      provider: 'fixture-stt',
      sourceKind: 'stt',
      sourceEventType: 'stt.final',
      sourceEventId: `event-${id}`,
      activity: 'normal',
      cacheDisposition: 'none',
      quantity: '1',
      unit: 'seconds',
      occurredAt: '2026-10-15T01:00:00.000Z',
      priceCard: { id: card.id, version: card.version },
      ...overrides,
    };
  }

  it('adds segment_index over a 004 ledger and reruns as a no-op', async () => {
    await ledger.migrate();
    await ledger.migrate();
    expect(
      (await pool.query('SELECT version FROM ovo_cost_schema_migrations ORDER BY version')).rows,
    ).toEqual([1, 2, 3, 4, 5].map((version) => ({ version })));
    await ledger.putPriceCard(card);
    const recorded = await ledger.recordUsage(usage({ segment: 63 }));
    await expect(
      pool.query('UPDATE ovo_cost_native_usage SET segment_index=64 WHERE id=$1', [
        recorded.usageId,
      ]),
    ).rejects.toThrow(/check/i);
  });

  it('stores the segment and refuses one out of range', async () => {
    const recorded = await ledger.recordUsage(usage({ segment: 2 }));
    const row = await pool.query('SELECT segment_index FROM ovo_cost_native_usage WHERE id=$1', [
      recorded.usageId,
    ]);
    expect(row.rows).toEqual([{ segment_index: 2 }]);
    const plain = await ledger.recordUsage(usage());
    const none = await pool.query('SELECT segment_index FROM ovo_cost_native_usage WHERE id=$1', [
      plain.usageId,
    ]);
    expect(none.rows).toEqual([{ segment_index: null }]);
    for (const segment of [-1, 64, 1.5])
      await expect(ledger.recordUsage(usage({ segment }))).rejects.toThrow(/segment/);
  });

  it('keeps idempotency: a retry is the same usage and a changed segment conflicts', async () => {
    const input = usage({ segment: 1 });
    const first = await ledger.recordUsage(input);
    expect((await ledger.recordUsage(input)).usageId).toBe(first.usageId);
    await expect(ledger.recordUsage({ ...input, segment: 2 })).rejects.toThrow();
    // Without a segment, the fingerprint is what it was before migration 005.
    const plain = usage();
    const again = await ledger.recordUsage({ ...plain, segment: undefined });
    expect((await ledger.recordUsage(plain)).usageId).toBe(again.usageId);
  });

  it('sums a call by segment, call-level usage first, each rounded once', async () => {
    const call = { callId: 'call-seg', workspaceId: 'ws-seg' };
    // 10 paise per 3 seconds: 1 s = 3.333 paise.
    await ledger.recordUsage(usage({ ...call, quantity: '2' }));
    for (let index = 0; index < 4; index += 1)
      await ledger.recordUsage(usage({ ...call, segment: 0 }));
    await ledger.recordUsage(usage({ ...call, sessionId: 'media-2', segment: 1, quantity: '3' }));
    const cost = await ledger.getCallCost('ws-seg', 'call-seg');
    expect(cost.totalPaise).toBe('30');
    expect(cost.sessionIds).toEqual(['media-1', 'media-2']);
    expect(cost.segments).toEqual([
      { index: null, currency: 'INR', estimatedPaise: '7', reconciledPaise: '0', totalPaise: '7' },
      { index: 0, currency: 'INR', estimatedPaise: '13', reconciledPaise: '0', totalPaise: '13' },
      { index: 1, currency: 'INR', estimatedPaise: '10', reconciledPaise: '0', totalPaise: '10' },
    ]);
    expect((await ledger.getCallCost('ws-seg', 'no-call')).segments).toEqual([]);
  });
});
