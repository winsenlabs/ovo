import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresCostLedger } from '@winsendotai/ovo-plugin-ledger';
import { registerCostRoutes } from '../src/routes/cost.ts';

const databaseUrl = process.env.LEDGER_TEST_DATABASE_URL;
const apps: FastifyInstance[] = [];

describe.skipIf(!databaseUrl)('GET /v1/calls/:callId/cost on the PostgreSQL ledger', () => {
  // A schema of its own: other suites page the shared ledger's cards and expect only their own.
  const schema = `call_cost_${randomUUID().replaceAll('-', '')}`;
  let ledger: PostgresCostLedger;

  beforeAll(async () => {
    ledger = new PostgresCostLedger({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`,
    });
    await ledger.pool.query(`CREATE SCHEMA ${schema}`);
    await ledger.migrate();
  });

  afterAll(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await ledger.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await ledger.close();
  });

  // P11, call 4e4d2228 on 2026-10-07: the worker keys usage by its media session id, the call
  // record by the job id, so the route read the wrong session and every call cost 0. Each LLM
  // step there was also a fraction of a paise, which per-event rounding billed as 0.
  it('returns a live call cost from the media session its usage was keyed by', async () => {
    const run = randomUUID();
    const callId = `call-${run}`;
    const sessionId = `media-session-${run}`;
    await ledger.putPriceCard({
      id: 'openai-gpt-input-p11',
      version: '2026-10-07',
      provider: 'openai',
      unit: 'input_tokens',
      currency: 'USD',
      minorUnitsPerBlock: '40',
      blockQuantity: '1000000',
      effectiveAt: '2026-10-07T00:00:00.000Z',
      provenance: 'fixture: 0.40 USD per million input tokens',
    });
    await ledger.putFxVersion({
      id: 'usd-inr-p11',
      version: '2026-10',
      baseCurrency: 'USD',
      quoteCurrency: 'INR',
      rateNumerator: '8345',
      rateDenominator: '100',
      effectiveAt: '2026-10-01T00:00:00.000Z',
      provenance: 'fixture FX',
    });
    for (let step = 0; step < 30; step += 1)
      await ledger.recordUsage({
        idempotencyKey: `usage:${sessionId}:llm:${step}`,
        workspaceId: 'workspace-a',
        sessionId,
        callId,
        provider: 'openai',
        providerRequestId: `${run}-${step}`,
        sourceKind: 'llm',
        sourceEventType: 'provider.inference.reported',
        sourceEventId: `${sessionId}:${step}`,
        activity: 'normal',
        cacheDisposition: 'none',
        quantity: '400',
        unit: 'input_tokens',
        occurredAt: '2026-10-07T12:59:00.000Z',
        priceCard: { id: 'openai-gpt-input-p11', version: '2026-10-07' },
        fx: { id: 'usd-inr-p11', version: '2026-10' },
      });
    const app = buildApp();
    registerCostRoutes({
      app,
      ledger,
      controlStore: { getCall: vi.fn(async () => ({ id: callId }) as never) },
      requireRole: (request) => ({
        identityId: 'identity-a',
        workspaceId: 'workspace-a',
        role: request.headers['x-role'] === 'admin' ? 'admin' : 'viewer',
      }),
      audit: vi.fn(),
    });

    const response = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/cost` });

    expect(response.statusCode).toBe(200);
    // 30 steps x 400 tokens x 0.40 USD/M = 0.48 US cents = 40.056 paise, rounded once.
    expect(response.json()).toMatchObject({
      workspaceId: 'workspace-a',
      callId,
      estimatedPaise: '40',
      totalPaise: '40',
    });
    // The media session id is private below admin (live diagnostics withholds it too).
    expect(response.json()).not.toHaveProperty('sessionIds');
    const admin = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/cost`,
      headers: { 'x-role': 'admin' },
    });
    expect(admin.json()).toMatchObject({ callId, sessionIds: [sessionId], totalPaise: '40' });
    // What the route used to read: the call id is no ledger session.
    expect((await ledger.getSessionCost('workspace-a', callId)).totalPaise).toBe('0');
  });
});

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  apps.push(app);
  return app;
}
