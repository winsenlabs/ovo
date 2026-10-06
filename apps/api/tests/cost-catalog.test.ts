import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  VENDOR_PRICE_CATALOG,
  vendorPriceCard,
  type CostLedgerService,
} from '@winsendotai/ovo-plugin-ledger';
import type { Role } from '@winsendotai/ovo-plugin-storage';
import { registerCostRoutes } from '../src/routes/cost.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// OPS-13/14: price cards name their model, and the dated vendor catalog imports in one click.
describe('price catalog routes', () => {
  it('accepts a model and provisional flag on a price card', async () => {
    const putPriceCard = vi.fn(async (input) => input);
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger({ putPriceCard }),
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit: vi.fn(),
    });
    const body = { ...priceCard(), model: 'gpt-6-luna', provisional: true };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'admin' },
      payload: body,
    });
    expect(response.statusCode).toBe(201);
    expect(putPriceCard).toHaveBeenCalledWith(body);
    const blank = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-cards',
      headers: { 'x-test-role': 'admin' },
      payload: { ...body, model: ' ' },
    });
    expect(blank.statusCode).toBe(400);
  });

  it('lists the catalog with each entry’s state in the ledger across every page', async () => {
    const [first, second] = VENDOR_PRICE_CATALOG;
    const listPriceCards = vi.fn(async (_limit?: number, cursor?: string) =>
      cursor
        ? { items: [{ ...vendorPriceCard(second!), version: '2025-01-01' }] }
        : { items: [vendorPriceCard(first!)], nextCursor: 'page-2' },
    );
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger: fakeLedger({ listPriceCards }),
      controlStore: { getCall: vi.fn() },
      requireRole,
      audit: vi.fn(),
    });
    const response = await app.inject({ method: 'GET', url: '/v1/cost/price-catalog' });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as { card: { id: string }; status: string }[];
    expect(items).toHaveLength(VENDOR_PRICE_CATALOG.length);
    expect(items[0]).toMatchObject({ card: { id: first!.card.id }, status: 'imported' });
    expect(items[1]).toMatchObject({ status: 'update_available', storedVersion: '2025-01-01' });
    expect(items[2]).toMatchObject({ status: 'not_imported' });
    expect(listPriceCards).toHaveBeenCalledTimes(2);
  });

  it('imports catalog entries as audited price cards, admin only, and rejects unknown ids', async () => {
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
    const id = 'elevenlabs-tts-flash-v2-5';
    const forbidden = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-catalog/import',
      headers: { 'x-test-role': 'editor' },
      payload: { ids: [id] },
    });
    expect(forbidden.statusCode).toBe(403);
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-catalog/import',
      headers: { 'x-test-role': 'admin' },
      payload: { ids: [id, 'invented-price'] },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().message).toContain('invented-price');
    expect(putPriceCard).not.toHaveBeenCalled();
    const imported = await app.inject({
      method: 'POST',
      url: '/v1/cost/price-catalog/import',
      headers: { 'x-test-role': 'admin' },
      payload: { ids: [id, id] },
    });
    expect(imported.statusCode).toBe(201);
    expect(putPriceCard).toHaveBeenCalledOnce();
    expect(imported.json().items[0]).toMatchObject({
      id,
      model: 'eleven_flash_v2_5',
      provenance: expect.stringContaining('https://elevenlabs.io/pricing/api (retrieved '),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cost.price-card.import', resourceId: id }),
    );
  });
});

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: 'validation_error' });
    const status = (error as { statusCode?: number }).statusCode ?? 500;
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
  return { listPriceCards: vi.fn(async () => ({ items: [] })), ...overrides } as CostLedgerService;
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
