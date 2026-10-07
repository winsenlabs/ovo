import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresCostLedger, type PriceCardVersion, type RecordUsageInput } from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('call cost on the PostgreSQL ledger (P11)', () => {
  let pool: Pool;
  let ledger: PostgresCostLedger;
  const card: PriceCardVersion = {
    id: 'tts-inr',
    version: 'v1',
    provider: 'fixture-tts',
    unit: 'characters',
    currency: 'INR',
    minorUnitsPerBlock: '25',
    blockQuantity: '100',
    effectiveAt: '2026-09-20T00:00:00.000Z',
    provenance: 'fixture price publication',
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: postgresUrl });
    ledger = new PostgresCostLedger(pool);
    await ledger.migrate();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE
      ovo_cost_allocations,ovo_cost_allocation_batches,ovo_cost_corrections,ovo_cost_charges,
      ovo_cost_native_usage,ovo_cost_budget_adjustments,ovo_cost_reservations,ovo_cost_budgets,
      ovo_cost_fx_versions,ovo_cost_price_cards CASCADE`);
    await ledger.putPriceCard(card);
  });

  afterAll(async () => {
    await pool?.end();
  });

  function usage(overrides: Partial<RecordUsageInput> = {}): RecordUsageInput {
    const id = randomUUID();
    return {
      idempotencyKey: `usage-${id}`,
      workspaceId: 'single-org-compat',
      sessionId: 'session-1',
      callId: 'call-1',
      attemptId: 'attempt-1',
      provider: 'fixture-tts',
      providerRequestId: `request-${id}`,
      sourceKind: 'tts-generation',
      sourceEventType: 'tts.completed',
      sourceEventId: `event-${id}`,
      activity: 'normal',
      cacheDisposition: 'generation',
      quantity: '100',
      unit: 'characters',
      occurredAt: '2026-09-20T01:00:00.000Z',
      priceCard: { id: card.id, version: card.version },
      ...overrides,
    };
  }

  // P11, calls 4e4d2228 and 8cbac365 on 2026-10-07: every OpenAI and decision step priced at a
  // fraction of a US cent, rounded to 0 cents and so 0 paise, and the calls were never billed.
  it('adds a call sub-paise charges exactly and rounds to paise once', async () => {
    const llm = {
      ...card,
      id: 'llm-usd',
      provider: 'openai',
      unit: 'input_tokens',
      currency: 'USD',
      minorUnitsPerBlock: '40',
      blockQuantity: '1000000',
    };
    await ledger.putPriceCard(llm);
    await ledger.putFxVersion({
      id: 'usd-inr',
      version: '2026-10',
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rateNumerator: '8345',
      rateDenominator: '100',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      provenance: 'fixture RBI reference',
    });
    const step = (sessionId: string) =>
      usage({
        sessionId,
        provider: 'openai',
        sourceKind: 'llm',
        cacheDisposition: 'none',
        quantity: '400',
        unit: 'input_tokens',
        priceCard: { id: llm.id, version: llm.version },
        fx: { id: 'usd-inr', version: '2026-10' },
      });
    const first = await ledger.recordUsage(step('media-1'));
    // One step: 400 x 40 / 1e6 = 0.016 US cents = 1.3352 paise; rounded alone it is 0.
    expect(first).toMatchObject({ nativeAmountMinor: '0', amountPaise: '0' });
    for (let index = 1; index < 20; index += 1) await ledger.recordUsage(step('media-1'));
    for (let index = 0; index < 10; index += 1) await ledger.recordUsage(step('media-2'));
    // 20 x 1.3352 = 26.704 paise and 10 x 1.3352 = 13.352 paise, each rounded once.
    expect(await ledger.getSessionCost('single-org-compat', 'media-1')).toMatchObject({
      estimatedPaise: '27',
      totalPaise: '27',
    });
    expect(await ledger.getSessionCost('single-org-compat', 'media-2')).toMatchObject({
      totalPaise: '13',
    });
    // The call is both media sessions, found by the call id their rows carry: 40.056 paise.
    expect(await ledger.getCallCost('single-org-compat', 'call-1')).toEqual({
      workspaceId: 'single-org-compat',
      callId: 'call-1',
      sessionIds: ['media-1', 'media-2'],
      currency: 'INR',
      estimatedPaise: '40',
      reconciledPaise: '0',
      totalPaise: '40',
      provisional: false,
      provisionalPriceCards: [],
    });
    expect(await ledger.getCallCost('another-workspace', 'call-1')).toMatchObject({
      sessionIds: [],
      totalPaise: '0',
    });
  });

  it('keeps reconciled amounts whole and charges recorded before exact amounts', async () => {
    const reconciled = await ledger.recordUsage(usage({ quantity: '2' }));
    await ledger.reconcileUsage({
      idempotencyKey: 'invoice-exact',
      workspaceId: 'single-org-compat',
      usageId: reconciled.usageId,
      providerInvoiceId: 'invoice-1',
      providerInvoiceLineId: 'line-1',
      actualAmountMinor: '7',
      currency: 'INR',
      occurredAt: '2026-09-21T00:00:00.000Z',
    });
    const legacy = await ledger.recordUsage(usage({ quantity: '10' }));
    // A charge written before migration 004 has no exact amount; its rounded paise stands in.
    await pool.query(
      'UPDATE ovo_cost_charges SET exact_amount_paise=NULL, amount_paise=3 WHERE usage_id=$1',
      [legacy.usageId],
    );
    await ledger.recordUsage(usage({ quantity: '1' }));
    expect(await ledger.getSessionCost('single-org-compat', 'session-1')).toMatchObject({
      // 3 (legacy) + 0.25 (1 character at 25 paise per 100), rounded once.
      estimatedPaise: '3',
      reconciledPaise: '7',
      totalPaise: '10',
    });
  });
});
