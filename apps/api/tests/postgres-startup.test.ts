import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;

integration('PostgreSQL management API startup', () => {
  it('starts with encrypted-store credentials and never returns plaintext', async () => {
    const workspaceId = `api-${randomUUID()}`;
    const { app, composition } = await buildManagementApi({
      storageAdapter: 'postgres',
      controlDatabaseUrl: databaseUrl,
      storageMaxConnections: 4,
      secretBackend: 'encrypted-store',
      secretsMasterKey: Buffer.alloc(32, 9).toString('base64'),
      sessionSecret: 'postgres-api-test-session',
      identities: [
        {
          id: 'operator',
          label: 'Operator',
          token: 'postgres-api-token',
          defaultWorkspaceId: workspaceId,
          workspaces: { [workspaceId]: 'admin' },
        },
      ],
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const created = await app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: { authorization: 'Bearer postgres-api-token' },
        payload: {
          label: 'Self-hosted key',
          provider: 'fixture',
          type: 'api-key',
          environment: 'production',
          value: 'postgres-secret-value',
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain('postgres-secret-value');
      expect(created.json().backend).toBe('encrypted-store');
      const headers = { authorization: 'Bearer postgres-api-token' };
      for (const url of [
        '/v1/cost/price-cards',
        '/v1/cost/budgets',
        '/v1/evaluation-datasets',
        '/v1/infrastructure',
        '/v1/operations/campaigns',
      ]) {
        const response = await app.inject({ method: 'GET', url, headers });
        expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
      }
      const performance = await app.inject({
        method: 'GET',
        headers,
        url: '/v1/performance?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&source=simulation',
      });
      expect(performance.statusCode, performance.body).toBe(200);
    } finally {
      await composition.dispose();
    }
  });

  it('refuses PostgreSQL without an explicit production-safe secret backend', async () => {
    await expect(
      buildManagementApi({
        storageAdapter: 'postgres',
        controlDatabaseUrl: databaseUrl,
        secretBackend: 'local',
        secretsMasterKey: Buffer.alloc(32, 9).toString('base64'),
        sessionSecret: 'postgres-api-test-session',
        identities: [
          {
            id: 'operator',
            label: 'Operator',
            token: 'postgres-api-token',
            defaultWorkspaceId: 'local',
            workspaces: { local: 'admin' },
          },
        ],
      }),
    ).rejects.toThrow('requires encrypted-store or aws-secrets-manager');
  });
});
