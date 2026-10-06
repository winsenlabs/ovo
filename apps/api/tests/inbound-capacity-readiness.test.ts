import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import { readInboundReadiness } from '../src/inbound-readiness.ts';
import { registerOperationsRoutes } from '../src/routes/operations.ts';

// OPS-4: readiness lived only on the dispatcher's /health, so the API (and the console's inbound
// page) showed `readyProtected: 0` with no reason while OVO_INBOUND_ENABLED was still false.
const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const report = {
  admissionEnabled: false,
  readyWorkers: 1,
  readyProtected: 0,
  warmFloor: 2,
  ready: true,
  reasons: ['OVO_INBOUND_ENABLED=false: workers register no protected inbound slot'],
  observedAt: '2026-10-06T00:00:00.000Z',
  ageMs: 4_000,
  stale: false,
};

function build(inboundReadiness?: () => Promise<typeof report | null>) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerOperationsRoutes({
    app,
    store: {} as never,
    requireRole: () => ({ workspaceId: 'org', identityId: 'viewer', role: 'viewer' }) as never,
    operations: {
      organizationId: 'org',
      inbound: { readyProtectedCapacity: async () => 0 },
    } as unknown as OperationsService,
    infrastructure: inboundReadiness ? { inboundReadiness } : undefined,
  });
  return app;
}

describe('GET /v1/operations/inbound/capacity', () => {
  it('returns the dispatcher’s readiness and its reasons next to readyProtected', async () => {
    const response = await build(async () => report).inject('/v1/operations/inbound/capacity');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ readyProtected: 0, readiness: report });
  });

  it('returns readiness null when no dispatcher has published one', async () => {
    expect(
      (await build(async () => null).inject('/v1/operations/inbound/capacity')).json(),
    ).toEqual({ readyProtected: 0, readiness: null });
    expect((await build().inject('/v1/operations/inbound/capacity')).json()).toEqual({
      readyProtected: 0,
      readiness: null,
    });
  });
});

describe('readInboundReadiness', () => {
  it('reads the dispatcher row and marks it stale past the capacity-signal age limit', async () => {
    const signal = {
      admissionEnabled: false,
      readyWorkers: 1,
      readyProtected: 0,
      warmFloor: 2,
      ready: true,
      reasons: ['no ready idle worker'],
    };
    const query = vi.fn(async () => ({
      rows: [{ signal, signal_at: new Date('2026-10-06T00:00:00.000Z'), age_ms: '45000.5' }],
    }));
    expect(await readInboundReadiness({ query } as never, 30_000)).toEqual({
      ...signal,
      observedAt: '2026-10-06T00:00:00.000Z',
      ageMs: 45_001,
      stale: true,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("service_key = 'inbound-readiness'"),
    );
    expect(await readInboundReadiness({ query: async () => ({ rows: [] }) } as never, 30_000)).toBe(
      null,
    );
  });
});
