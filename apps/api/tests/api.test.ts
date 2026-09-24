import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';
import type { BuildApiOptions } from '../src/types.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function api(overrides: Partial<BuildApiOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-api-'));
  directories.push(directory);
  return buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 3).toString('base64'),
    sessionSecret: 'test-session-secret',
    identities: [
      {
        id: 'admin-a',
        label: 'Admin A',
        token: 'token-a',
        defaultWorkspaceId: 'workspace-a',
        workspaces: { 'workspace-a': 'admin' },
      },
      {
        id: 'viewer-b',
        label: 'Viewer B',
        token: 'token-b',
        defaultWorkspaceId: 'workspace-b',
        workspaces: { 'workspace-b': 'viewer' },
      },
    ],
    ...overrides,
    pluginCatalog: [selectedSpeechFixture, ...(overrides.pluginCatalog ?? [])],
  });
}
const announcement = {
  name: 'Reminder',
  mode: 'announcement',
  message: 'Hello {{name}}',
  voice: selectedSpeechVoice,
  variables: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
};
function wav100ms() {
  const sampleRate = 8000,
    dataBytes = (sampleRate / 10) * 2,
    wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

describe('management API', () => {
  it('ignores forwarded TLS from untrusted clients', async () => {
    const { app, composition } = await api({ requireTlsForSecrets: true });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers: {
          authorization: 'Bearer token-a',
          'x-forwarded-proto': 'https',
        },
        payload: {
          label: 'Blocked',
          provider: 'fixture',
          type: 'api-key',
          environment: 'test',
          value: 'not-stored',
        },
      });
      expect(response.statusCode).toBe(426);
      expect(response.json().error.code).toBe('tls_required');
    } finally {
      await composition.dispose();
    }
  });

  it('authenticates a browser session and enforces workspace-scoped lookups and optimistic edits', async () => {
    const { app, composition } = await api();
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/session',
        payload: { token: 'token-a' },
      });
      expect(login.statusCode).toBe(200);
      expect(login.headers['set-cookie']).toContain('HttpOnly');
      expect(login.body).not.toContain('token-a');
      const cookie = String(login.headers['set-cookie']).split(';')[0];
      const created = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { cookie },
        payload: { config: announcement },
      });
      expect(created.statusCode).toBe(201);
      const agent = created.json();
      expect(created.headers.etag).toBe('"1"');
      const stale = await app.inject({
        method: 'PUT',
        url: `/v1/agents/${agent.id}`,
        headers: { cookie, 'if-match': '"0"' },
        payload: { config: { ...announcement, name: 'Changed' } },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error.code).toBe('draft_conflict');
      const crossWorkspace = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agent.id}`,
        headers: { authorization: 'Bearer token-b', 'x-workspace-id': 'workspace-a' },
      });
      expect(crossWorkspace.statusCode).toBe(404);
    } finally {
      await composition.dispose();
    }
  });

  it('returns only secret metadata and derives immutable release locks from approved definitions', async () => {
    const { app, composition } = await api();
    try {
      const headers = { authorization: 'Bearer token-a' };
      const secret = await app.inject({
        method: 'POST',
        url: '/v1/credentials',
        headers,
        payload: {
          label: 'LLM',
          provider: 'example',
          type: 'api-key',
          environment: 'test',
          value: 'never-return-this',
        },
      });
      expect(secret.statusCode).toBe(201);
      expect(secret.body).not.toContain('never-return-this');
      expect(secret.json()).not.toHaveProperty('value');
      const created = await app.inject({
          method: 'POST',
          url: '/v1/agents',
          headers,
          payload: { config: announcement },
        }),
        agent = created.json();
      const published = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agent.id}/releases`,
        headers,
        payload: { pluginIds: ['@winsendotai/ovo-behavior-announcement'] },
      });
      expect(published.statusCode).toBe(201);
      expect(published.json().plugins).toEqual([
        { id: '@winsendotai/ovo-behavior-announcement', version: '0.1.0' },
      ]);
      const simulation = await app.inject({
        method: 'POST',
        url: '/v1/simulations',
        headers,
        payload: { releaseId: published.json().id, input: 'start', variables: { name: 'Asha' } },
      });
      expect(simulation.statusCode).toBe(200);
      expect(simulation.json()).toMatchObject({ kind: 'simulation', output: 'Hello Asha' });
      const callId = simulation.json().callId,
        empty = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/recordings`, headers });
      expect(empty.json().items).toEqual([]);
      const wav = wav100ms();
      const uploaded = await app.inject({
        method: 'POST',
        url: `/v1/calls/${callId}/recordings`,
        headers,
        payload: { wavBase64: wav.toString('base64'), retentionDays: 1 },
      });
      expect(uploaded.statusCode).toBe(201);
      const audio = await app.inject({
        method: 'GET',
        url: `/v1/calls/${callId}/recordings/${uploaded.json().id}/audio`,
        headers,
      });
      expect(audio.statusCode).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
      expect(audio.rawPayload.equals(wav)).toBe(true);
      expect(uploaded.json().durationMs).toBe(100);
      const foreign = await app.inject({
        method: 'GET',
        url: `/v1/calls/${callId}/recordings/${uploaded.json().id}/audio`,
        headers: { authorization: 'Bearer token-b' },
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.body).not.toContain('.recordings');
      const missing = await app.inject({
        method: 'GET',
        url: `/v1/calls/${callId}/recordings/00000000-0000-4000-8000-000000000000/audio`,
        headers,
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('recording_not_found');
      expect(missing.body).not.toContain('.recordings');
    } finally {
      await composition.dispose();
    }
  });
});
