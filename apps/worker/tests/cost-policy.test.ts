import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import {
  createWorkerCostPolicyAttachment,
  inferenceMeterKey,
  WorkerCostPolicyController,
  type CostPolicy,
  type CostTerminationReason,
} from '../src/cost-policy.ts';
import { normalizeInferenceEvidence } from '../src/cost-inference.ts';

const postgresUrl = process.env.OVO_TEST_POSTGRES_URL;

describe.skipIf(!postgresUrl)('worker cost policy with PostgreSQL', () => {
  let ledger: PostgresCostLedger;

  beforeAll(async () => {
    ledger = new PostgresCostLedger({ connectionString: postgresUrl! });
    await ledger.migrate();
  });

  beforeEach(async () => {
    await ledger.pool.query(`TRUNCATE
      ovo_cost_allocations,ovo_cost_allocation_batches,ovo_cost_corrections,ovo_cost_charges,
      ovo_cost_native_usage,ovo_cost_budget_adjustments,ovo_cost_reservations,ovo_cost_budgets,
      ovo_cost_fx_versions,ovo_cost_price_cards CASCADE`);
    await ledger.putPriceCard({
      id: 'openai-characters',
      version: 'v1',
      provider: 'openai',
      unit: 'characters',
      currency: 'INR',
      minorUnitsPerBlock: '1',
      blockQuantity: '1',
      effectiveAt: '2026-09-20T00:00:00.000Z',
      provenance: 'test publication',
    });
    await Promise.all([
      putInferenceCard('openai-uncached-input', 'uncached_input_tokens', '2'),
      putInferenceCard('openai-cache-read', 'cache_read_input_tokens', '1'),
      putInferenceCard('openai-cache-write', 'cache_write_input_tokens', '3'),
      putInferenceCard('openai-output', 'output_tokens', '4'),
    ]);
    await ledger.putPriceCard({
      id: 'twilio-seconds',
      version: 'v1',
      provider: 'twilio',
      unit: 'audio_seconds',
      currency: 'INR',
      minorUnitsPerBlock: '1',
      blockQuantity: '1',
      effectiveAt: '2026-09-20T00:00:00.000Z',
      provenance: 'test publication',
    });
  });

  afterAll(async () => {
    await ledger.close();
  });

  it('denies low-balance admission before provider effects or usage writes', async () => {
    await ledger.createBudget({
      id: 'budget-low',
      workspaceId: 'workspace-a',
      limitPaise: '40',
      admissionOverspendPaise: '0',
    });
    const terminate = vi.fn();
    const controller = createController('session-low', policy('budget-low', '50'), terminate);

    const reservation = await controller.reserveBeforeAdmission();
    const accepted = controller.observeProviderUsage(providerUsage('request-not-started', '10'));
    const summary = await ledger.getSessionCost('workspace-a', 'session-low');

    expect(reservation).toMatchObject({ admitted: false, reason: 'budget-threshold' });
    expect(accepted).toBe(false);
    expect(summary.totalPaise).toBe('0');
    expect(terminate).not.toHaveBeenCalled();
  });

  it('records native usage idempotently, skips cache-hit generation, and bills elapsed carrier use', async () => {
    await createBudget('budget-usage');
    const terminate = vi.fn();
    const controller = createController('session-usage', policy('budget-usage', '3'), terminate);
    await controller.reserveBeforeAdmission();
    controller.beginActiveCall();

    expect(controller.observeProviderUsage(providerUsage('tts-request-1', '2'))).toBe(true);
    expect(controller.observeProviderUsage(providerUsage('tts-request-1', '2'))).toBe(true);
    expect(
      controller.recordCacheGeneration({
        meterKey: 'openai.streaming-tts.characters',
        provider: 'openai',
        quantity: '2',
        unit: 'characters',
        eventId: 'cache-hit-1',
        occurredAt: '2026-09-20T00:00:02.000Z',
        cacheDisposition: 'hit',
      }),
    ).toBe(true);
    expect(
      controller.recordElapsed({
        meterKey: 'twilio.carrier.audio_seconds',
        sourceKind: 'carrier',
        provider: 'twilio',
        elapsedMs: 1_500,
        eventId: 'carrier-window-1',
        occurredAt: '2026-09-20T00:00:03.000Z',
      }),
    ).toBe(true);

    const finalized = await controller.finalizeKnownUsage();
    const count = await ledger.pool.query(
      'SELECT count(*)::int AS count FROM ovo_cost_native_usage',
    );

    expect(count.rows[0]!.count).toBe(2);
    expect(finalized.cost.totalPaise).toBe('4');
    expect(finalized.reservation.budget).toMatchObject({ spentPaise: '4', reservedPaise: '0' });
    expect(finalized.lateBillingPossible).toBe(true);
    expect(terminate).toHaveBeenCalledWith('cost-spend-threshold');
  });

  it('requests termination at the configured duration and bounds pending usage', async () => {
    await createBudget('budget-timing');
    let timeout: (() => void) | undefined;
    const reasons: CostTerminationReason[] = [];
    const controller = createController(
      'session-timing',
      policy('budget-timing', '100'),
      (reason) => {
        reasons.push(reason);
      },
      {
        maxPendingUsage: 1,
        timers: {
          set: (_delay, callback) => {
            timeout = callback;
            return 'timer';
          },
          clear: () => undefined,
        },
      },
    );
    await controller.reserveBeforeAdmission();
    controller.beginActiveCall();
    timeout!();

    expect(reasons).toEqual(['cost-max-duration']);
    expect(
      controller.recordElapsed({
        meterKey: 'twilio.carrier.audio_seconds',
        sourceKind: 'media',
        provider: 'twilio',
        elapsedMs: 1_000,
        eventId: 'media-window-1',
        occurredAt: '2026-09-20T00:00:04.000Z',
      }),
    ).toBe(true);
    expect(
      controller.recordElapsed({
        meterKey: 'twilio.carrier.audio_seconds',
        sourceKind: 'media',
        provider: 'twilio',
        elapsedMs: 1_000,
        eventId: 'media-window-2',
        occurredAt: '2026-09-20T00:00:05.000Z',
      }),
    ).toBe(false);
    await controller.finalizeKnownUsage();
  });

  it('applies later admin invoice corrections to an already settled budget', async () => {
    await createBudget('budget-late');
    const controller = createController('session-late', policy('budget-late', '100'));
    await controller.reserveBeforeAdmission();
    controller.beginActiveCall();
    controller.observeProviderUsage(providerUsage('tts-request-late', '10'));
    await controller.finalizeKnownUsage();
    const usage = await ledger.pool.query(
      "SELECT id FROM ovo_cost_native_usage WHERE session_id='session-late'",
    );

    await ledger.reconcileUsage({
      idempotencyKey: 'invoice-line-late',
      workspaceId: 'workspace-a',
      usageId: usage.rows[0]!.id,
      providerInvoiceId: 'invoice-late',
      providerInvoiceLineId: 'line-late',
      actualAmountMinor: '15',
      currency: 'INR',
      occurredAt: '2026-09-21T00:00:00.000Z',
    });
    const budget = await ledger.getBudget('budget-late');

    expect(budget).toMatchObject({ spentPaise: '15', reservedPaise: '0' });
  });

  it('settles only known usage and reports omitted provider units without writing zero', async () => {
    await createBudget('budget-unknown');
    const controller = createController('session-unknown', policy('budget-unknown', '100'));
    await controller.reserveBeforeAdmission();
    controller.beginActiveCall();

    expect(
      controller.observeProviderUsage({
        provider: 'openai',
        operation: 'streaming-tts',
        unit: 'tokens',
        state: 'unavailable',
        missing: 'provider-omitted',
        elapsedMs: 20,
      }),
    ).toBe(true);
    const finalized = await controller.finalizeKnownUsage();
    const count = await ledger.pool.query(
      'SELECT count(*)::int AS count FROM ovo_cost_native_usage',
    );

    expect(count.rows[0]!.count).toBe(0);
    expect(finalized.cost.totalPaise).toBe('0');
    expect(finalized.missingProviderMeters).toEqual(['openai.streaming-tts.tokens']);
    expect(finalized.billingComplete).toBe(false);
    expect(finalized.caveat).toContain('later provider invoices');
  });

  it('records two inference steps once using disjoint cached and uncached token prices', async () => {
    await createBudget('budget-inference');
    const attachment = createWorkerCostPolicyAttachment({
      ledger,
      policy: policy('budget-inference', '1000'),
      workspaceId: 'workspace-a',
      sessionId: 'session-inference',
      callId: 'session-inference',
      sessionStartedAt: '2026-09-20T00:00:00.000Z',
      inference: { provider: 'openai', modelId: 'gpt-test' },
      requestTermination: vi.fn(),
    });
    await attachment.reserveBeforeAdmission();
    attachment.beginActiveCall();
    const first = {
      requestId: 'inference-request-1',
      modelId: 'gpt-test',
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        uncachedInputTokens: 30,
        cacheReadInputTokens: 50,
        cacheWriteInputTokens: 20,
        textOutputTokens: 8,
        reasoningOutputTokens: 2,
      },
    };
    const second = {
      requestId: 'inference-request-2',
      modelId: 'gpt-test',
      usage: {
        inputTokens: 40,
        outputTokens: 5,
        totalTokens: 45,
        uncachedInputTokens: 10,
        cacheReadInputTokens: 30,
        cacheWriteInputTokens: 0,
      },
    };

    attachment.inferenceUsage(first);
    attachment.inferenceUsage(first);
    attachment.inferenceUsage(second);
    attachment.inferenceUsage(second);
    const finalized = await attachment.finalizeKnownUsage();
    const rows = await ledger.pool.query<{
      provider_request_id: string;
      unit: string;
      quantity: string;
      amount_paise: string;
    }>(
      `SELECT u.provider_request_id,u.unit,u.quantity,c.amount_paise::text
       FROM ovo_cost_native_usage u JOIN ovo_cost_charges c ON c.usage_id=u.id
       WHERE u.session_id='session-inference'
       ORDER BY u.provider_request_id,u.unit`,
    );

    expect(new Set(rows.rows.map((row) => row.provider_request_id))).toEqual(
      new Set(['inference-request-1', 'inference-request-2']),
    );
    expect(rows.rows).toHaveLength(7);
    expect(rows.rows.filter((row) => row.unit === 'input_tokens')).toHaveLength(0);
    expect(
      rows.rows
        .filter((row) => row.unit === 'cache_read_input_tokens')
        .map((row) => [row.quantity, row.amount_paise]),
    ).toEqual([
      ['50', '50'],
      ['30', '30'],
    ]);
    expect(finalized.cost.totalPaise).toBe('280');
    expect(finalized.inferenceUsageEvidence).toEqual({
      reportedSteps: 2,
      estimatedSteps: 0,
      unknownSteps: 0,
      reasons: [],
    });
  });

  function createController(
    sessionId: string,
    inputPolicy: CostPolicy,
    terminate: (reason: CostTerminationReason) => void = vi.fn(),
    overrides: Partial<ConstructorParameters<typeof WorkerCostPolicyController>[0]> = {},
  ) {
    return new WorkerCostPolicyController({
      ledger,
      policy: inputPolicy,
      workspaceId: 'workspace-a',
      sessionId,
      callId: sessionId,
      sessionStartedAt: '2026-09-20T00:00:00.000Z',
      requiredMeterKeys: ['openai.streaming-tts.characters', 'twilio.carrier.audio_seconds'],
      requestTermination: terminate,
      ...overrides,
    });
  }

  async function createBudget(id: string) {
    return ledger.createBudget({
      id,
      workspaceId: 'workspace-a',
      limitPaise: '1000',
      admissionOverspendPaise: '0',
    });
  }

  async function putInferenceCard(id: string, unit: string, minorUnitsPerBlock: string) {
    return ledger.putPriceCard({
      id,
      version: 'v1',
      provider: 'openai',
      unit,
      currency: 'INR',
      minorUnitsPerBlock,
      blockQuantity: '1',
      effectiveAt: '2026-09-20T00:00:00.000Z',
      provenance: 'test publication',
    });
  }
});

describe('inference cost evidence normalization', () => {
  it('uses an explicit aggregate estimate when detailed counters are priced only in aggregate', () => {
    const fallback = inferenceMeterKey('openai', 'input_tokens');
    const normalized = normalizeInferenceEvidence(
      { provider: 'openai', modelId: 'gpt-test' },
      {
        requestId: 'request-policy-estimated',
        modelId: 'gpt-test',
        usage: {
          inputTokens: 20,
          outputTokens: 2,
          uncachedInputTokens: 10,
          cacheReadInputTokens: 5,
          cacheWriteInputTokens: 5,
        },
      },
      new Set([fallback, inferenceMeterKey('openai', 'output_tokens')]),
      '2026-09-20T00:00:00.000Z',
    );

    expect(normalized.state).toBe('estimated');
    expect(normalized.reasons).toEqual(['input-policy-aggregate-fallback']);
    expect(normalized.usage.map(({ unit, quantity }) => ({ unit, quantity }))).toEqual([
      { unit: 'input_tokens', quantity: '20' },
      { unit: 'output_tokens', quantity: '2' },
    ]);
  });

  it('uses an explicit aggregate estimate when cache details are incomplete', () => {
    const fallback = inferenceMeterKey('openai', 'input_tokens');
    const normalized = normalizeInferenceEvidence(
      { provider: 'openai', modelId: 'gpt-test' },
      {
        requestId: 'request-estimated',
        modelId: 'gpt-test',
        usage: { inputTokens: 20, outputTokens: 2, cacheReadInputTokens: 5 },
      },
      new Set([fallback, inferenceMeterKey('openai', 'output_tokens')]),
      '2026-09-20T00:00:00.000Z',
    );

    expect(normalized.state).toBe('estimated');
    expect(normalized.reasons).toEqual(['input-breakdown-incomplete-fallback']);
    expect(
      normalized.usage.map(({ unit, quantity, sourceEventType }) => ({
        unit,
        quantity,
        sourceEventType,
      })),
    ).toEqual([
      {
        unit: 'input_tokens',
        quantity: '20',
        sourceEventType: 'provider.inference.estimated-input',
      },
      {
        unit: 'output_tokens',
        quantity: '2',
        sourceEventType: 'provider.inference.reported',
      },
    ]);
  });

  it('keeps inconsistent input details unknown instead of double counting them', () => {
    const normalized = normalizeInferenceEvidence(
      { provider: 'openai', modelId: 'gpt-test' },
      {
        requestId: 'request-unknown',
        modelId: 'gpt-test',
        usage: {
          inputTokens: 20,
          outputTokens: 2,
          uncachedInputTokens: 10,
          cacheReadInputTokens: 10,
          cacheWriteInputTokens: 10,
        },
      },
      new Set([inferenceMeterKey('openai', 'output_tokens')]),
      '2026-09-20T00:00:00.000Z',
    );

    expect(normalized.state).toBe('unknown');
    expect(normalized.reasons).toEqual(['input-breakdown-inconsistent']);
    expect(normalized.usage.map((usage) => usage.unit)).toEqual(['output_tokens']);
  });
});

function policy(budgetId: string, reservationPaise: string): CostPolicy {
  return {
    budgetId,
    reservationPaise,
    maxCallSeconds: 120,
    priceCards: {
      'openai.streaming-tts.characters': { id: 'openai-characters', version: 'v1' },
      'twilio.carrier.audio_seconds': { id: 'twilio-seconds', version: 'v1' },
      'openai.inference.uncached_input_tokens': {
        id: 'openai-uncached-input',
        version: 'v1',
      },
      'openai.inference.cache_read_input_tokens': {
        id: 'openai-cache-read',
        version: 'v1',
      },
      'openai.inference.cache_write_input_tokens': {
        id: 'openai-cache-write',
        version: 'v1',
      },
      'openai.inference.output_tokens': { id: 'openai-output', version: 'v1' },
    },
  };
}

function providerUsage(requestId: string, quantity: string) {
  return {
    provider: 'openai' as const,
    operation: 'streaming-tts' as const,
    requestId,
    elapsedMs: 20,
    quantity,
    unit: 'characters' as const,
    state: 'estimated' as const,
  };
}
