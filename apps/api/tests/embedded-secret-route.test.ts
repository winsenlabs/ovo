import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })),
);
const headers = { authorization: 'Bearer admin-token' };

async function api() {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-embedded-secret-'));
  directories.push(directory);
  return buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 4).toString('base64'),
    sessionSecret: 'test-session-secret',
    identities: [
      {
        id: 'admin',
        label: 'Admin',
        token: 'admin-token',
        defaultWorkspaceId: 'w',
        workspaces: { w: 'admin' },
      },
    ],
    pluginCatalog: [],
  });
}

it('accepts output caps in a provider binding and still refuses embedded secrets', async () => {
  const { app, composition } = await api();
  try {
    const credential = await app.inject({
      method: 'POST',
      url: '/v1/credentials',
      headers,
      payload: {
        label: 'Model key',
        provider: 'fixture-llm',
        type: 'api-key',
        environment: 'test',
        value: 'stored-model-secret',
      },
    });
    expect(credential.statusCode).toBe(201);
    const create = (config: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/provider-bindings',
        headers,
        payload: {
          label: 'Model',
          provider: 'fixture-llm',
          environment: 'test',
          credentialId: credential.json().id,
          config,
        },
      });
    // LAT-7: the old substring check answered 400 embedded_secret for every *Tokens setting.
    const capped = await create({ model: 'fixture', maxOutputTokens: 300, keyterms: ['OVO'] });
    expect(capped.statusCode).toBe(201);
    expect(capped.json().config).toEqual({
      model: 'fixture',
      maxOutputTokens: 300,
      keyterms: ['OVO'],
    });
    for (const config of [
      { apiKey: 'leaked-fixture-value' },
      { upstream: { note: 'sk-proj-leakedfixturevalue1234' } },
    ]) {
      const refused = await create(config);
      expect(refused.statusCode).toBe(400);
      expect(refused.body).not.toContain('leaked');
    }
  } finally {
    await composition.dispose();
  }
});
