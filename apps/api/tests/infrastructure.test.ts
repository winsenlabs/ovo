import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createInfrastructureRuntime } from '../src/infrastructure-runtime.ts';
import { PostgresInfrastructureService } from '../src/infrastructure-service.ts';
import { registerInfrastructureRoutes } from '../src/routes/infrastructure.ts';

describe('infrastructure snapshot route', () => {
  it('requires viewer access and guards release ownership before reading', async () => {
    const app = Fastify();
    const snapshot = vi.fn(async () => ({ organizationId: 'one-org' }));
    const getRelease = vi.fn(async (workspaceId: string, releaseId: string) =>
      workspaceId === 'one-org' && releaseId === 'release-1' ? { id: releaseId } : undefined,
    );
    const requireRole = vi.fn(() => ({ workspaceId: 'one-org' }));
    registerInfrastructureRoutes({
      app,
      infrastructure: { organizationId: 'one-org', snapshot } as never,
      store: { getRelease },
      requireRole,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/infrastructure?releaseId=release-1',
    });
    expect(response.statusCode).toBe(200);
    expect(requireRole).toHaveBeenCalledWith(expect.anything(), 'viewer');
    expect(getRelease).toHaveBeenCalledWith('one-org', 'release-1');
    expect(snapshot).toHaveBeenCalledWith('one-org', 'release-1');
    await app.close();
  });

  it('returns generic not-found for another organization or unknown release', async () => {
    for (const scenario of [
      { workspaceId: 'other-org', release: { id: 'release-1' } },
      { workspaceId: 'one-org', release: undefined },
    ]) {
      const app = Fastify();
      const snapshot = vi.fn();
      registerInfrastructureRoutes({
        app,
        infrastructure: { organizationId: 'one-org', snapshot } as never,
        store: { getRelease: vi.fn(async () => scenario.release) },
        requireRole: () => ({ workspaceId: scenario.workspaceId }),
      });
      const response = await app.inject({
        method: 'GET',
        url: '/v1/infrastructure?releaseId=release-1',
      });
      expect(response.statusCode).toBe(404);
      expect(snapshot).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('returns an explicit unavailable response when main does not install the service', async () => {
    const app = Fastify();
    registerInfrastructureRoutes({
      app,
      store: { getRelease: vi.fn() },
      requireRole: () => ({ workspaceId: 'one-org' }),
    });
    const response = await app.inject({ method: 'GET', url: '/v1/infrastructure' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'infrastructure_unavailable' } });
    await app.close();
  });

  it('validates the max-two pool bound before allocating a database connection', async () => {
    await expect(
      createInfrastructureRuntime({
        organizationId: 'one-org',
        databaseUrl: 'postgresql://127.0.0.1:1/not-contacted',
        maxConnections: 3,
      }),
    ).rejects.toThrow('maxConnections must be an integer between 1 and 2');
  });

  it('uses null rather than fake zeroes when durable metric tables are unavailable', async () => {
    const query = vi.fn(async () => ({
      rows: [{ orchestration: null, recordings: null, telemetry: null, control: null }],
    }));
    const service = new PostgresInfrastructureService({ query } as never, {
      organizationId: 'one-org',
      installationEnabled: true,
      capacityCeiling: null,
    });
    const snapshot = await service.snapshot('one-org');
    expect(query).toHaveBeenCalledOnce();
    expect(snapshot.workers).toMatchObject({
      ready: null,
      busy: null,
      total: null,
      sampledWorkers: null,
      samplesTruncated: null,
    });
    expect(snapshot.queue).toMatchObject({ depth: null, oldestAgeMs: null });
    expect(snapshot.recordings).toBeNull();
    expect(snapshot.telemetry).toBeNull();
    expect(snapshot.process.cpuPercentAverage).toBeNull();
  });
});
