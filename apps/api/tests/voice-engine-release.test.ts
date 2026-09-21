import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { describe, expect, it, vi } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

describe('voice engine release publication', () => {
  it('pins a worker-only replacement while simulations keep the unchanged behavior', async () => {
    const directory = await mkdtemp('/var/tmp/ovo-engine-release-');
    const apply = vi.fn(() => {
      throw new Error('worker-only replacement must not apply in the API');
    });
    const replacement = definePlugin(
      {
        id: '@example/worker-voice-engine',
        version: '1.2.3',
        contractVersion: 1,
        scope: 'session',
        requires: ['ovo.behavior', 'ovo.media.duplex', 'ovo.tts-streaming'],
        provides: ['ovo.voice-session-engine'],
        configSchema: { type: 'object', additionalProperties: true },
        secretFields: [],
      },
      apply,
    );
    const { app, composition } = await buildManagementApi({
      databaseFile: join(directory, 'store.sqlite'),
      secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
      sessionSecret: 'fixture-session-secret',
      requireTlsForSecrets: false,
      pluginCatalog: [replacement],
      identities: [
        {
          id: 'operator',
          label: 'Operator',
          token: 'fixture-token',
          defaultWorkspaceId: 'local',
          workspaces: { local: 'admin' },
        },
      ],
    });
    const headers = { authorization: 'Bearer fixture-token' };
    try {
      const agent = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers,
        payload: {
          config: {
            name: 'Published engine replacement',
            mode: 'announcement',
            message: 'Unchanged announcement behavior',
          },
        },
      });
      expect(agent.statusCode, agent.body).toBe(201);

      const release = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agent.json().id}/releases`,
        headers,
        payload: {
          pluginIds: ['@winsendotai/ovo-behavior-announcement', replacement.manifest.id],
        },
      });
      expect(release.statusCode, release.body).toBe(201);
      expect(release.json().plugins).toContainEqual({
        id: replacement.manifest.id,
        version: replacement.manifest.version,
      });

      const simulation = await app.inject({
        method: 'POST',
        url: '/v1/simulations',
        headers,
        payload: { releaseId: release.json().id, input: 'start', variables: {} },
      });
      expect(simulation.statusCode, simulation.body).toBe(200);
      expect(simulation.json().output).toBe('Unchanged announcement behavior');
      expect(apply).not.toHaveBeenCalled();
    } finally {
      await composition.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
