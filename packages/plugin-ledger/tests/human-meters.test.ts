import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HUMAN_METER_KEYS,
  HUMAN_METER_PROVIDER,
  HUMAN_METER_UNIT,
} from '@winsendotai/ovo-contracts';
import { PostgresCostLedger, type PriceCardVersion, type RecordUsageInput } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

/**
 * Wave 17: a person's time on a call is metered like any provider usage. The ledger needs no new
 * column: the meters ride the segment index Wave 16 added, with provider `ovo` and unit `seconds`.
 */
describe.skipIf(!postgresUrl)('human queue meters on the PostgreSQL ledger', () => {
  const schema = `cost_human_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let ledger: PostgresCostLedger;
  const card = (id: string, minor: string): PriceCardVersion => ({
    id,
    version: 'v1',
    provider: HUMAN_METER_PROVIDER,
    unit: HUMAN_METER_UNIT,
    currency: 'INR',
    minorUnitsPerBlock: minor,
    blockQuantity: '60',
    effectiveAt: '2026-10-01T00:00:00.000Z',
    provenance: 'fixture: operator time per minute',
  });
  const operatorCard = card('ovo-human-operator', '50');
  const roomCard = card('ovo-human-room', '10');

  beforeAll(async () => {
    admin = new Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: postgresUrl, options: `-c search_path=${schema}` });
    ledger = new PostgresCostLedger(pool);
    await ledger.migrate();
    await ledger.putPriceCard(operatorCard);
    await ledger.putPriceCard(roomCard);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  const usage = (
    meter: keyof typeof HUMAN_METER_KEYS,
    quantity: string,
    over: Partial<RecordUsageInput> = {},
  ): RecordUsageInput => {
    const id = randomUUID();
    const priced = meter === 'operatorSeconds' ? operatorCard : roomCard;
    return {
      idempotencyKey: `usage-${id}`,
      workspaceId: 'ws',
      sessionId: 'media-1',
      callId: 'call-human',
      provider: HUMAN_METER_PROVIDER,
      sourceKind: 'worker',
      sourceEventType: `human.${meter}.estimated`,
      sourceEventId: `${HUMAN_METER_KEYS[meter]}:${id}`,
      activity: 'normal',
      cacheDisposition: 'none',
      quantity,
      unit: HUMAN_METER_UNIT,
      occurredAt: '2026-10-15T09:00:00.000Z',
      priceCard: { id: priced.id, version: priced.version },
      ...over,
    };
  };

  it('prices operator and room seconds and shows them on the human segment', async () => {
    const call = { callId: 'call-seg', workspaceId: 'ws-seg' };
    await ledger.recordUsage(usage('operatorSeconds', '90', { ...call, segment: 2 }));
    await ledger.recordUsage(usage('roomSeconds', '120', { ...call, segment: 2 }));
    // The router and an agent segment keep their own lines.
    await ledger.recordUsage(usage('roomSeconds', '30', { ...call, segment: 1 }));
    await ledger.recordUsage(usage('roomSeconds', '60', call));
    const cost = await ledger.getCallCost('ws-seg', 'call-seg');
    // 90 s = 75 paise operator + 120 s = 20 paise room on segment 2; 30 s = 5 paise; 60 s = 10 paise.
    expect(cost.segments).toEqual([
      {
        index: null,
        currency: 'INR',
        estimatedPaise: '10',
        reconciledPaise: '0',
        totalPaise: '10',
      },
      { index: 1, currency: 'INR', estimatedPaise: '5', reconciledPaise: '0', totalPaise: '5' },
      { index: 2, currency: 'INR', estimatedPaise: '95', reconciledPaise: '0', totalPaise: '95' },
    ]);
    expect(cost.totalPaise).toBe('110');
    expect(cost.provisional).toBe(false);
  });

  it('records a retried meter once', async () => {
    const input = usage('operatorSeconds', '60', {
      callId: 'call-retry',
      workspaceId: 'ws-retry',
      segment: 2,
    });
    const first = await ledger.recordUsage(input);
    expect((await ledger.recordUsage(input)).usageId).toBe(first.usageId);
    expect((await ledger.getCallCost('ws-retry', 'call-retry')).totalPaise).toBe('50');
  });

  it('keeps fractional seconds exact until the call total rounds once', async () => {
    const call = { callId: 'call-frac', workspaceId: 'ws-frac', segment: 2 };
    for (let i = 0; i < 3; i += 1) await ledger.recordUsage(usage('operatorSeconds', '0.6', call));
    // 3 x 0.6 s = 1.8 s = 1.5 paise, rounded once for the segment.
    const cost = await ledger.getCallCost('ws-frac', 'call-frac');
    expect(cost.segments).toEqual([
      { index: 2, currency: 'INR', estimatedPaise: '2', reconciledPaise: '0', totalPaise: '2' },
    ]);
  });

  it('refuses a meter whose price card does not exist: the worker leaves unpriced meters out', async () => {
    await expect(
      ledger.recordUsage(
        usage('operatorSeconds', '10', { priceCard: { id: 'ovo-human-operator', version: 'v9' } }),
      ),
    ).rejects.toThrow(/price card/i);
    // Nothing was written for the refused meter.
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM ovo_cost_native_usage WHERE source_event_type = 'human.operatorSeconds.estimated' AND call_id = 'call-human'`,
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
