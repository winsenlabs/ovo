import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  PostgresCostLedger,
  type CostLedgerService,
  type ReconcileUsageInput,
} from '@winsendotai/ovo-plugin-ledger';
import type { Role } from '@winsendotai/ovo-plugin-storage';
import { registerCostRoutes } from '../src/routes/cost.ts';

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('cost API routes', () => {
  it('returns an explicit 503 instead of empty catalog data when the ledger is absent', async () => {
    const app = buildApp();
    registerCostRoutes({
      app,
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: '/v1/cost/price-cards' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'cost_ledger_unavailable',
      message: 'Cost ledger is not configured',
    });
  });

  it('enforces admin mutation, strict schemas, bounded pages, and audited immutable writes', async () => {
    const putPriceCard = vi.fn(async (input) => input);
    const audit = vi.fn();
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger({ putPriceCard }),
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit,
    });
    const body = priceCard();

    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'editor' },
      payload: body,
    });
    const extra = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'admin' },
      payload: { ...body, arbitrary: true },
    });
    const oversizedPage = await app.inject({
      method: 'GET',
      url: '/v1/cost/price-cards?limit=101',
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'admin' },
      payload: body,
    });

    expect(forbidden.statusCode).toBe(403);
    expect(extra.statusCode).toBe(400);
    expect(oversizedPage.statusCode).toBe(400);
    expect(created.statusCode).toBe(201);
    expect(putPriceCard).toHaveBeenCalledWith(body);
    expect(audit).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      actorId: 'identity-a',
      action: 'cost.price-card.put',
      resourceType: 'price-card',
      resourceId: 'openai-tts',
      payload: { version: '2026-09-20' },
    });
  });

  it('calculates explicit string-money scenarios and rejects numeric money', async () => {
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger(),
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit: vi.fn(),
    });

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/cost/scenario',
      payload: scenario(),
    });
    const numeric = await app.inject({
      method: 'POST',
      url: '/v1/cost/scenario',
      payload: { ...scenario(), targetRevenuePaise: 1_000 },
    });

    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({
      totalCostPaise: '573',
      marginPaise: '427',
      targetRevenuePaise: '1000',
    });
    expect(numeric.statusCode).toBe(400);
  });

  it('checks call ownership before returning workspace-scoped cost', async () => {
    const getCall = vi.fn(async (workspaceId: string, callId: string) =>
      workspaceId === 'workspace-a' && callId === 'call-a' ? ({ id: callId } as never) : undefined,
    );
    const getSessionCost = vi.fn(async (workspaceId: string, sessionId: string) => ({
      workspaceId,
      sessionId,
      currency: 'INR' as const,
      estimatedPaise: '0',
      reconciledPaise: '573',
      totalPaise: '573',
    }));
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger({ getSessionCost }),
      controlStore: { getCall },
      requireRole,
      audit: vi.fn(),
    });

    const missing = await app.inject({ method: 'GET', url: '/v1/calls/call-b/cost' });
    const found = await app.inject({ method: 'GET', url: '/v1/calls/call-a/cost' });

    expect(missing.statusCode).toBe(404);
    expect(found.statusCode).toBe(200);
    expect(getSessionCost).toHaveBeenCalledOnce();
    expect(getSessionCost).toHaveBeenCalledWith('workspace-a', 'call-a');
  });

  it('binds reconciliation to the authenticated workspace and audits provenance', async () => {
    let received: ReconcileUsageInput | undefined;
    const reconcileUsage = vi.fn(async (input: ReconcileUsageInput) => {
      received = input;
      return {
        usageId: input.usageId,
        correctionId: 'correction-a',
        deltaPaise: '7',
        effectiveAmountPaise: input.actualAmountMinor,
        state: 'reconciled' as const,
      };
    });
    const audit = vi.fn();
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger({ reconcileUsage }),
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cost/reconciliation',
      headers: { 'x-test-role': 'admin' },
      payload: {
        idempotencyKey: 'invoice-line-a',
        usageId: 'usage-a',
        providerInvoiceId: 'invoice-a',
        providerInvoiceLineId: 'line-a',
        actualAmountMinor: '57',
        currency: 'INR',
        occurredAt: '2026-09-20T00:00:00.000Z',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(received?.workspaceId).toBe('workspace-a');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-a',
        action: 'cost.reconciliation.append',
        resourceId: 'usage-a',
      }),
    );
  });

  it('creates or updates only the authenticated workspace budget policy', async () => {
    const createBudget = vi.fn(async (policy) => ({
      ...policy,
      spentPaise: '0',
      reservedPaise: '0',
      availableForAdmissionPaise: '1050',
      overLimit: false,
    }));
    const audit = vi.fn();
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger({ createBudget }),
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/cost/budgets',
      headers: { 'x-test-role': 'admin' },
      payload: { id: 'budget-a', limitPaise: '1000', admissionOverspendPaise: '50' },
    });

    expect(response.statusCode).toBe(201);
    expect(createBudget).toHaveBeenCalledWith({
      id: 'budget-a',
      workspaceId: 'workspace-a',
      limitPaise: '1000',
      admissionOverspendPaise: '50',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-a',
        action: 'cost.budget.put',
        resourceId: 'budget-a',
      }),
    );
  });
});

const databaseUrl = process.env.LEDGER_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('cost API with PostgreSQL ledger', () => {
  let ledger: PostgresCostLedger;

  beforeAll(async () => {
    ledger = new PostgresCostLedger({ connectionString: databaseUrl! });
    await ledger.migrate();
  });

  afterEach(async () => {
    await ledger.close();
  });

  it('writes and pages real immutable catalogs and reads scoped budgets', async () => {
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger,
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit: vi.fn(),
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'admin' },
      payload: priceCard(),
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'admin' },
      payload: { ...priceCard(), id: 'openai-tts-second' },
    });
    const fxCreated = await app.inject({
      method: 'POST',
      url: '/v1/cost/fx-versions',
      headers: { 'x-test-role': 'admin' },
      payload: {
        id: 'usd-inr',
        version: '2026-09-20',
        baseCurrency: 'USD',
        quoteCurrency: 'INR',
        rateNumerator: '8345',
        rateDenominator: '100',
        effectiveAt: '2026-09-20T00:00:00.000Z',
        provenance: 'operator FX publication',
      },
    });
    const budgetCreated = await app.inject({
      method: 'POST',
      url: '/v1/cost/budgets',
      headers: { 'x-test-role': 'admin' },
      payload: { id: 'budget-a', limitPaise: '900', admissionOverspendPaise: '0' },
    });
    const budgetUpdated = await app.inject({
      method: 'POST',
      url: '/v1/cost/budgets',
      headers: { 'x-test-role': 'admin' },
      payload: { id: 'budget-a', limitPaise: '1000', admissionOverspendPaise: '50' },
    });
    const cards = await app.inject({ method: 'GET', url: '/v1/cost/price-cards?limit=1' });
    const firstPage = cards.json<{
      items: { id: string }[];
      nextCursor: string;
    }>();
    const nextCards = await app.inject({
      method: 'GET',
      url: `/v1/cost/price-cards?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    });
    const fx = await app.inject({ method: 'GET', url: '/v1/cost/fx-versions?limit=1' });
    const budgets = await app.inject({
      method: 'GET',
      url: '/v1/cost/budgets?limit=1',
      headers: { 'x-test-role': 'admin' },
    });

    expect(created.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(fxCreated.statusCode).toBe(201);
    expect(budgetCreated.statusCode).toBe(201);
    expect(budgetUpdated.statusCode).toBe(201);
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    expect(nextCards.json<{ items: { id: string }[] }>().items).toHaveLength(1);
    expect(
      new Set([firstPage.items[0]!.id, nextCards.json<{ items: { id: string }[] }>().items[0]!.id]),
    ).toEqual(new Set(['openai-tts', 'openai-tts-second']));
    expect(fx.json()).toMatchObject({
      items: [{ id: 'usd-inr', version: '2026-09-20', rateNumerator: '8345' }],
    });
    expect(budgets.json()).toMatchObject({
      items: [{ id: 'budget-a', workspaceId: 'workspace-a', limitPaise: '1000' }],
    });
  });
});

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: 'validation_error', message: 'Request validation failed' });
    const status =
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    return reply.code(status).send({ error: status === 403 ? 'forbidden' : 'internal_error' });
  });
  apps.push(app);
  return app;
}

function requireRole(request: FastifyRequest, required: Role) {
  const role = (request.headers['x-test-role'] ?? 'viewer') as Role;
  const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
  if (rank[role] < rank[required]) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
  return { identityId: 'identity-a', workspaceId: 'workspace-a', role };
}

function fakeLedger(overrides: Partial<CostLedgerService> = {}): CostLedgerService {
  return {
    listPriceCards: vi.fn(async () => ({ items: [] })),
    listFxVersions: vi.fn(async () => ({ items: [] })),
    listBudgets: vi.fn(async () => ({ items: [] })),
    ...overrides,
  } as CostLedgerService;
}

function priceCard() {
  return {
    id: 'openai-tts',
    version: '2026-09-20',
    provider: 'openai',
    unit: 'character',
    currency: 'INR',
    minorUnitsPerBlock: '1',
    blockQuantity: '1',
    effectiveAt: '2026-09-20T00:00:00.000Z',
    provenance: 'operator publication',
  };
}

function scenario() {
  return {
    targetRevenuePaise: '1000',
    durationSeconds: '120',
    components: [
      ['telephony', '200'],
      ['tax', '100'],
      ['speech-generation', '150'],
      ['carrier-media', '100'],
      ['idle', '23'],
    ].map(([category, amountMinor]) => ({
      id: category,
      category,
      amountMinor,
      currency: 'INR',
      assumption: `explicit ${category} fixture`,
    })),
    cache: {
      generatedUnits: '1',
      hitUnits: '2',
      generationBilledOnce: true,
      carrierMediaStillBilled: true,
      assumption: 'one generation and two carrier playbacks',
    },
    marginScope: 'explicit two-minute fixture only',
  };
}
