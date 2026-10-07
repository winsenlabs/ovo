import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';
import { SPEECH_CLIP_STATUS_FIELDS } from '../src/speech-prerender.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

const databaseUrl = process.env.OVO_TEST_POSTGRES_URL;
const integration = databaseUrl ? describe : describe.skip;
const headers = { authorization: 'Bearer prerender-token' };

const agentConfig = (speechCache: boolean) => ({
  name: 'Pre-render',
  mode: 'faq',
  language: 'en-IN',
  message: 'Hello, this is **Asha** from the bank.',
  faq: [
    { id: 'emi', question: 'What is my EMI?', answer: 'Your EMI is ₹4,850.' },
    { id: 'name', question: 'Who am I?', answer: 'You are {{customer.name}}.' },
  ],
  variables: {
    type: 'object',
    properties: { customer: { type: 'object', properties: { name: { type: 'string' } } } },
  },
  voice: selectedSpeechVoice,
  ...(speechCache ? { speechCache: { enabled: true } } : {}),
});

async function publish(app: Awaited<ReturnType<typeof buildManagementApi>>['app'], cache: boolean) {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers,
    payload: { config: agentConfig(cache) },
  });
  expect(created.statusCode, created.body).toBe(201);
  const agentId = created.json().id as string;
  const release = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agentId}/releases`,
    headers,
    payload: {},
  });
  expect(release.statusCode, release.body).toBe(201);
  return { agentId, releaseId: release.json().id as string };
}

const identities = (workspaceId: string) => [
  {
    id: 'operator',
    label: 'Operator',
    token: 'prerender-token',
    defaultWorkspaceId: workspaceId,
    workspaces: { [workspaceId]: 'admin' as const },
  },
];

describe('speech clip status without a durable clip store (TTS-9)', () => {
  it('publishes normally and reports the inventory on post-filter text', async () => {
    const directory = await mkdtemp('/var/tmp/ovo-speech-prerender-');
    const { app, composition } = await buildManagementApi({
      databaseFile: join(directory, 'store.sqlite'),
      secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
      sessionSecret: 'speech-prerender-session-secret',
      requireTlsForSecrets: false,
      pluginCatalog: [selectedSpeechFixture],
      identities: identities('local'),
    });
    try {
      const enabled = await publish(app, true);
      const status = await app.inject({
        method: 'GET',
        url: `/v1/agents/${enabled.agentId}/releases/${enabled.releaseId}/speech-clips`,
        headers,
      });
      expect(status.statusCode, status.body).toBe(200);
      // Greeting, fixed FAQ answer, default processing/clarification/uncertainty lines and the
      // default turn detector's idle prompt are fixed; the templated answer is rendered per call.
      expect(status.json()).toMatchObject({ state: 'unavailable', total: 7, perCall: 1, ready: 0 });
      expect(status.json().inventorySha256).toMatch(/^[0-9a-f]{64}$/);
      // The documented fields, exactly: scripts that read `status` got undefined on 2026-10-07.
      expect(Object.keys(status.json()).sort()).toEqual([...SPEECH_CLIP_STATUS_FIELDS].sort());
      const disabled = await publish(app, false);
      const off = await app.inject({
        method: 'GET',
        url: `/v1/agents/${disabled.agentId}/releases/${disabled.releaseId}/speech-clips`,
        headers,
      });
      expect(off.json()).toMatchObject({ state: 'disabled', total: 7, pending: 0 });
      const mismatched = await app.inject({
        method: 'GET',
        url: `/v1/agents/${disabled.agentId}/releases/${enabled.releaseId}/speech-clips`,
        headers,
      });
      expect(mismatched.statusCode).toBe(404);
    } finally {
      await composition.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

integration('speech clip pre-render queue on publish (TTS-9)', () => {
  it('queues an opted-in release for the workers and reports its progress', async () => {
    const workspaceId = `prerender-${randomUUID()}`;
    const { app, composition } = await buildManagementApi({
      storageAdapter: 'postgres',
      controlDatabaseUrl: databaseUrl,
      storageMaxConnections: 4,
      secretBackend: 'encrypted-store',
      secretsMasterKey: Buffer.alloc(32, 9).toString('base64'),
      sessionSecret: 'speech-prerender-session-secret',
      pluginCatalog: [selectedSpeechFixture],
      identities: identities(workspaceId),
    });
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const enabled = await publish(app, true);
      const disabled = await publish(app, false);
      const jobs = await pool.query<{ release_id: string; state: string; total: number }>(
        `SELECT release_id, state, total FROM ovo_speech_prerender_jobs WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(jobs.rows).toEqual([{ release_id: enabled.releaseId, state: 'queued', total: 7 }]);
      const status = await app.inject({
        method: 'GET',
        url: `/v1/agents/${enabled.agentId}/releases/${enabled.releaseId}/speech-clips`,
        headers,
      });
      expect(status.json()).toMatchObject({
        state: 'queued',
        total: 7,
        ready: 0,
        pending: 7,
        perCall: 1,
      });
      const off = await app.inject({
        method: 'GET',
        url: `/v1/agents/${disabled.agentId}/releases/${disabled.releaseId}/speech-clips`,
        headers,
      });
      expect(off.json().state).toBe('disabled');
    } finally {
      await pool.end();
      await composition.dispose();
    }
  }, 30_000);
});
