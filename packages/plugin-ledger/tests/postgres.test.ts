import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerConflictError,
  PostgresCostLedger,
  type PriceCardVersion,
  type RecordUsageInput,
} from '../src/index.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('PostgreSQL production cost ledger', () => {
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

  it('runs a versioned migration with only ovo_cost_ ledger tables', async () => {
    const version = await pool.query('SELECT version FROM ovo_cost_schema_migrations');
    expect(version.rows).toEqual([{ version: 1 }]);
  });

  it('keeps price card versions immutable and idempotent', async () => {
    await expect(ledger.putPriceCard(card)).resolves.toEqual(card);
    await expect(ledger.putPriceCard({ ...card, minorUnitsPerBlock: '26' })).rejects.toBeInstanceOf(
      LedgerConflictError,
    );
    const fx = {
      id: 'usd-inr',
      version: 'daily-1',
      baseCurrency: 'USD',
      quoteCurrency: 'INR' as const,
      rateNumerator: '8345',
      rateDenominator: '100',
      effectiveAt: '2026-09-20T00:00:00.000Z',
      provenance: 'fixture RBI reference',
    };
    await expect(ledger.putFxVersion(fx)).resolves.toEqual(fx);
    await expect(ledger.putFxVersion({ ...fx, rateNumerator: '8400' })).rejects.toBeInstanceOf(
      LedgerConflictError,
    );
  });

  it('appends native usage idempotently by key and source provenance', async () => {
    const input = usage();
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => ledger.recordUsage(input)),
    );
    const first = concurrent[0]!;
    expect(concurrent.every((row) => row.usageId === first.usageId)).toBe(true);
    expect(await ledger.recordUsage({ ...input, idempotencyKey: 'alternate-key' })).toEqual(first);
    expect(
      (await pool.query('SELECT count(*)::int AS count FROM ovo_cost_native_usage')).rows[0].count,
    ).toBe(1);
  });

  it('rejects conflicting reuse of native source provenance', async () => {
    const input = usage();
    await ledger.recordUsage(input);
    await expect(
      ledger.recordUsage({ ...input, idempotencyKey: 'different', quantity: '101' }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
  });

  it('bills cache generation once while every cached carrier playback remains chargeable', async () => {
    const generation = usage();
    await ledger.recordUsage(generation);
    await ledger.recordUsage({ ...generation, idempotencyKey: 'same-generation-retry' });
    const mediaCard = {
      ...card,
      id: 'carrier-media',
      provider: 'fixture-carrier',
      unit: 'seconds',
      minorUnitsPerBlock: '2',
      blockQuantity: '1',
    };
    await ledger.putPriceCard(mediaCard);
    for (const index of [1, 2])
      await ledger.recordUsage(
        usage({
          idempotencyKey: `carrier-${index}`,
          provider: 'fixture-carrier',
          providerRequestId: `carrier-request-${index}`,
          sourceKind: 'carrier',
          sourceEventType: 'carrier.media.completed',
          sourceEventId: `carrier-event-${index}`,
          cacheDisposition: 'hit',
          quantity: '10',
          unit: 'seconds',
          priceCard: { id: mediaCard.id, version: mediaCard.version },
        }),
      );
    expect(await ledger.getSessionCost('single-org-compat', 'session-1')).toMatchObject({
      estimatedPaise: '65',
      totalPaise: '65',
    });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM ovo_cost_native_usage WHERE source_kind='carrier'",
        )
      ).rows[0].count,
    ).toBe(2);
  });

  it('rejects a generation charge labeled as a cache hit', async () => {
    await expect(ledger.recordUsage(usage({ cacheDisposition: 'hit' }))).rejects.toThrow(
      'cache hit',
    );
  });

  it('requires explicit immutable FX and converts exactly to paise', async () => {
    const usdCard = { ...card, id: 'tts-usd', currency: 'USD', minorUnitsPerBlock: '1' };
    await ledger.putPriceCard(usdCard);
    const input = usage({ priceCard: { id: usdCard.id, version: usdCard.version } });
    await expect(ledger.recordUsage(input)).rejects.toThrow('explicit immutable FX');
    await ledger.putFxVersion({
      id: 'usd-inr',
      version: 'daily-1',
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rateNumerator: '8345',
      rateDenominator: '100',
      effectiveAt: '2026-09-20T00:00:00.000Z',
      provenance: 'fixture RBI reference',
    });
    await expect(
      ledger.recordUsage({ ...input, fx: { id: 'usd-inr', version: 'daily-1' } }),
    ).resolves.toMatchObject({ nativeAmountMinor: '1', amountPaise: '83' });
  });

  it('records positive and negative provider invoice correction deltas idempotently', async () => {
    const recorded = await ledger.recordUsage(usage());
    await expect(
      ledger.reconcileUsage({
        idempotencyKey: 'wrong-workspace-line',
        workspaceId: 'other-workspace',
        usageId: recorded.usageId,
        providerInvoiceId: 'wrong-workspace-invoice',
        providerInvoiceLineId: 'wrong-workspace-line',
        actualAmountMinor: '30',
        currency: 'INR',
        occurredAt: '2026-09-21T00:00:00.000Z',
      }),
    ).rejects.toThrow('Usage charge not found');
    const first = await ledger.reconcileUsage({
      idempotencyKey: 'invoice-line-1',
      workspaceId: 'single-org-compat',
      usageId: recorded.usageId,
      providerInvoiceId: 'invoice-1',
      providerInvoiceLineId: 'line-1',
      actualAmountMinor: '30',
      currency: 'INR',
      occurredAt: '2026-09-21T00:00:00.000Z',
    });
    expect(first.deltaPaise).toBe('5');
    expect(
      await ledger.reconcileUsage({
        idempotencyKey: 'same-source-new-key',
        workspaceId: 'single-org-compat',
        usageId: recorded.usageId,
        providerInvoiceId: 'invoice-1',
        providerInvoiceLineId: 'line-1',
        actualAmountMinor: '30',
        currency: 'INR',
        occurredAt: '2026-09-21T00:00:00.000Z',
      }),
    ).toEqual(first);
    const lowered = await ledger.reconcileUsage({
      idempotencyKey: 'invoice-line-2',
      workspaceId: 'single-org-compat',
      usageId: recorded.usageId,
      providerInvoiceId: 'invoice-1',
      providerInvoiceLineId: 'line-2',
      actualAmountMinor: '20',
      currency: 'INR',
      occurredAt: '2026-09-22T00:00:00.000Z',
    });
    expect(lowered.deltaPaise).toBe('-10');
    expect((await ledger.getSessionCost('single-org-compat', 'session-1')).reconciledPaise).toBe(
      '20',
    );
  });

  it('allocates failed attempts, transfers and retries without losing a paise', async () => {
    const recorded = await ledger.recordUsage(usage({ quantity: '404' }));
    const allocation = await ledger.allocateCharge({
      idempotencyKey: 'allocation-1',
      chargeId: recorded.chargeId,
      basis: 'attempt-weight',
      targets: [
        { id: 'failed', weight: '1', reason: 'failed-attempt', attemptId: 'attempt-1' },
        { id: 'transfer', weight: '1', reason: 'transfer', callId: 'call-2' },
        { id: 'retry', weight: '2', reason: 'retry', attemptId: 'attempt-2' },
      ],
    });
    expect(
      allocation.targets.reduce((sum, row) => sum + BigInt(row.amountPaise), 0n).toString(),
    ).toBe(allocation.amountPaise);
    expect(new Set(allocation.targets.map((row) => row.reason))).toEqual(
      new Set(['failed-attempt', 'transfer', 'retry']),
    );
  });

  it('serializes concurrent reservation admission at the bounded overspend ceiling', async () => {
    await ledger.createBudget({
      id: 'daily',
      workspaceId: 'single-org-compat',
      limitPaise: '100',
      admissionOverspendPaise: '20',
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        ledger.reserveBudget({
          budgetId: 'daily',
          reservationId: `reservation-${index}`,
          amountPaise: '30',
          sourceRef: `job-${index}`,
        }),
      ),
    );
    expect(results.filter((row) => row.admitted)).toHaveLength(4);
    expect(await ledger.getBudget('daily')).toMatchObject({
      reservedPaise: '120',
      availableForAdmissionPaise: '0',
    });
  });

  it('updates a workspace budget policy without discarding incurred or reserved amounts', async () => {
    await ledger.createBudget({
      id: 'daily',
      workspaceId: 'single-org-compat',
      limitPaise: '100',
      admissionOverspendPaise: '0',
    });
    await ledger.reserveBudget({
      budgetId: 'daily',
      reservationId: 'active-policy-update',
      amountPaise: '20',
      sourceRef: 'session:active-policy-update',
    });

    await expect(
      ledger.createBudget({
        id: 'daily',
        workspaceId: 'single-org-compat',
        limitPaise: '200',
        admissionOverspendPaise: '10',
      }),
    ).resolves.toMatchObject({
      limitPaise: '200',
      admissionOverspendPaise: '10',
      reservedPaise: '20',
    });
    await expect(
      ledger.createBudget({
        id: 'daily',
        workspaceId: 'other-workspace',
        limitPaise: '200',
        admissionOverspendPaise: '10',
      }),
    ).rejects.toThrow('another workspace');
  });

  it('settles incurred overspend, releases unused reservations, and applies late bills', async () => {
    await ledger.createBudget({
      id: 'daily',
      workspaceId: 'single-org-compat',
      limitPaise: '100',
      admissionOverspendPaise: '10',
    });
    await ledger.reserveBudget({
      budgetId: 'daily',
      reservationId: 'unused-call',
      amountPaise: '10',
      sourceRef: 'call-unused',
    });
    expect(await ledger.releaseReservation('unused-call')).toMatchObject({
      state: 'released',
      budget: { reservedPaise: '0' },
    });
    await ledger.reserveBudget({
      budgetId: 'daily',
      reservationId: 'active-call',
      amountPaise: '60',
      sourceRef: 'call-1',
    });
    expect(await ledger.settleReservation('active-call', '130')).toMatchObject({
      state: 'settled',
      budget: { spentPaise: '130', overLimit: true },
    });
    await expect(
      ledger.reserveBudget({
        budgetId: 'daily',
        reservationId: 'blocked-new-call',
        amountPaise: '1',
        sourceRef: 'call-2',
      }),
    ).resolves.toMatchObject({ admitted: false, reason: 'budget-threshold' });
    const late = {
      budgetId: 'daily',
      idempotencyKey: 'late-invoice',
      deltaPaise: '25',
      sourceRef: 'provider-invoice-after-call',
    };
    expect(await ledger.applyLateAdjustment(late)).toMatchObject({
      spentPaise: '155',
      overLimit: true,
    });
    expect(await ledger.applyLateAdjustment(late)).toMatchObject({ spentPaise: '155' });
  });
});
