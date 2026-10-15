import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

async function api(routing: {
  routingEnabled?: boolean;
  routingExternalEnabled?: boolean;
  routingTransferEnabled?: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-routing-'));
  const { app } = await buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
    sessionSecret: 'routing-route-session-secret',
    requireTlsForSecrets: false,
    identities: [
      {
        id: 'viewer',
        label: 'Viewer',
        token: 'fixture-viewer',
        defaultWorkspaceId: 'demo',
        workspaces: { demo: 'viewer' },
      },
    ],
    ...routing,
  });
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: 'Bearer fixture-viewer' } });
  return {
    get,
    close: async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('serves the routing routes dark by default (Wave 15, A1)', async () => {
  const { get, close } = await api({});
  try {
    expect((await get('/v1/routing/status')).json()).toEqual({
      enabled: false,
      externalEnabled: false,
      transferEnabled: false,
    });
    const pools = await get('/v1/routing/pools');
    expect([pools.statusCode, pools.json().error.code]).toEqual([404, 'routing_disabled']);
  } finally {
    await close();
  }
});

it('stays off without the operations database even with the flags on', async () => {
  const { get, close } = await api({
    routingEnabled: true,
    routingExternalEnabled: true,
    routingTransferEnabled: true,
  });
  try {
    expect((await get('/v1/routing/status')).json()).toEqual({
      enabled: false,
      externalEnabled: true,
      transferEnabled: true,
    });
    const pools = await get('/v1/routing/pools');
    expect([pools.statusCode, pools.json().error.code]).toEqual([503, 'operations_unavailable']);
  } finally {
    await close();
  }
});
