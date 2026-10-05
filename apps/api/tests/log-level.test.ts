import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

async function levelWith(value: string | undefined) {
  vi.stubEnv('OVO_LOG_LEVEL', value);
  const directory = mkdtempSync(join(tmpdir(), 'ovo-log-level-'));
  directories.push(directory);
  const { app, composition } = await buildManagementApi({
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
    logger: true,
  });
  try {
    return app.log.level;
  } finally {
    await composition.dispose();
  }
}

it('runs the request logger at OVO_LOG_LEVEL, defaulting to info', async () => {
  expect(await levelWith('warn')).toBe('warn');
  expect(await levelWith(undefined)).toBe('info');
  expect(await levelWith('verbose')).toBe('info');
});
