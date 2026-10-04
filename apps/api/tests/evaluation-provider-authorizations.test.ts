import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProviderEvaluationAuthorizationRoutes } from '../src/routes/evaluation-provider-authorizations.ts';

const authorization = {
  id: 'evalauth_one',
  workspaceId: 'workspace-a',
  releaseId: 'release-a',
  releaseFingerprint: 'sha256:release-a',
  bindingVersion: 'binding-a:2026-09-20T00:00:00.000Z',
  provider: 'openai',
  modelId: 'gpt-evaluation',
  budgetId: 'budget-a',
  maximumReservationPaise: '100',
  createdBy: 'admin-a',
  createdAt: '2026-09-20T00:00:00.000Z',
};

describe('provider evaluation authorization routes', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('allows only the admin surface to create, list, and idempotently revoke authorizations', async () => {
    const app = Fastify();
    apps.push(app);
    const createForRelease = vi.fn(async () => authorization);
    const list = vi.fn(async () => ({ items: [authorization] }));
    const revoke = vi.fn(async () => ({
      ...authorization,
      revokedBy: 'admin-a',
      revokedAt: '2026-09-20T01:00:00.000Z',
    }));
    const audit = vi.fn(async () => undefined);
    const requireRole = vi.fn((_request: unknown, _role: string) => ({
      identityId: 'admin-a',
      workspaceId: 'workspace-a',
      role: 'admin' as const,
    }));
    registerProviderEvaluationAuthorizationRoutes({
      app,
      evaluations: { providerAuthorizations: { createForRelease, list, revoke } } as never,
      store: { audit } as never,
      requireRole,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/v1/evaluation-provider-authorizations',
      payload: {
        releaseId: 'release-a',
        maximumReservationPaise: '100',
        idempotencyKey: 'console-request-a',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(createForRelease).toHaveBeenCalledWith({
      workspaceId: 'workspace-a',
      createdBy: 'admin-a',
      releaseId: 'release-a',
      maximumReservationPaise: '100',
      idempotencyKey: 'console-request-a',
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/evaluation-provider-authorizations?limit=25',
    });
    expect(listed.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith('workspace-a', 25, undefined);

    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/evaluation-provider-authorizations/evalauth_one/revoke',
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith('workspace-a', 'evalauth_one', 'admin-a');
    expect(requireRole.mock.calls.map((call) => call[1])).toEqual(['admin', 'admin', 'admin']);
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('returns installation unavailable without a configured durable registry', async () => {
    const app = Fastify();
    apps.push(app);
    registerProviderEvaluationAuthorizationRoutes({
      app,
      store: { audit: vi.fn() } as never,
      requireRole: () => ({
        identityId: 'admin-a',
        workspaceId: 'workspace-a',
        role: 'admin',
      }),
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/evaluation-provider-authorizations',
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'provider_evaluations_unavailable' });
  });
});
