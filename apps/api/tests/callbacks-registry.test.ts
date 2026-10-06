import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

it('serves the callback routes from the management API (AGT-15)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-callbacks-'));
  const { app } = await buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
    sessionSecret: 'callbacks-route-session-secret',
    requireTlsForSecrets: false,
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'fixture-operator',
        defaultWorkspaceId: 'demo',
        workspaces: { demo: 'admin' },
      },
    ],
  });
  try {
    const headers = { authorization: 'Bearer fixture-operator' };
    const list = await app.inject({ method: 'GET', url: '/v1/callbacks', headers });
    expect(list.statusCode, list.body).toBe(200);
    // SQLite keeps no durable call outcomes, so it has no callbacks to list.
    expect(list.json()).toEqual({ available: false, items: [], nextCursor: null });
    expect((await app.inject({ method: 'GET', url: '/v1/callbacks' })).statusCode).toBe(401);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
