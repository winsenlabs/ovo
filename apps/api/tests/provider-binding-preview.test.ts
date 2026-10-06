import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NetPort } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import type { ProviderBinding } from '@winsendotai/ovo-plugin-storage';
import { elevenLabsSttPlugin } from '../../../packages/plugin-stt-elevenlabs/src/index.ts';
import { openAiTtsPlugin } from '../../../packages/plugin-tts-openai/src/index.ts';
import { openAiTtsTemplate } from '../../../packages/plugin-tts-openai/src/testing.ts';
import {
  DEFAULT_PREVIEW_TEXT,
  registerProviderBindingPreview,
} from '../src/routes/provider-binding-preview.ts';
import { buildManagementApi } from '../src/server.ts';

const at = '2026-10-06T10:00:00.000Z';
const binding = (over: Partial<ProviderBinding> = {}): ProviderBinding => ({
  id: 'tts-1',
  workspaceId: 'ws',
  label: 'OpenAI voice',
  provider: 'openai',
  pluginId: '@winsendotai/ovo-provider-openai-tts',
  environment: 'production',
  credentialId: 'cred-1',
  config: { model: 'gpt-4o-mini-tts', voice: 'alloy' },
  createdAt: at,
  updatedAt: at,
  ...over,
});

function build(net: NetPort, bindings: ProviderBinding[]) {
  const app = Fastify({ logger: false });
  // The management API answers a validation error with 400; so does this bare app.
  app.setErrorHandler((caught, _request, reply) =>
    reply.code(caught instanceof z.ZodError ? 400 : 500).send({ error: (caught as Error).message }),
  );
  const audits: Record<string, unknown>[] = [];
  const resolved: string[] = [];
  registerProviderBindingPreview({
    app,
    store: {
      getProviderBinding: async (_workspace, id) => bindings.find((item) => item.id === id),
      audit: async (entry) => audits.push(entry),
    },
    secrets: {
      resolve: async (_workspace, credentialId) => {
        resolved.push(credentialId);
        return 'fixture-key';
      },
    },
    catalog: [openAiTtsPlugin, elevenLabsSttPlugin],
    requireRole: () => ({ workspaceId: 'ws', identityId: 'operator' }),
    error: (reply, status, code, message) => reply.code(status).send({ error: { code, message } }),
    net,
  });
  return { app, audits, resolved };
}

describe('POST /v1/provider-bindings/:id/preview (TTS-3)', () => {
  it('renders the line through the binding as 8 kHz PCM WAV and audits it', async () => {
    const net = createFixtureNet(
      openAiTtsTemplate({
        format: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 },
        language: 'en',
        sessionId: 'preview',
        turns: [],
        agentTexts: ['Namaste, this is Asha.'],
      }),
    );
    const { app, audits, resolved } = build(net, [binding()]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-bindings/tts-1/preview',
      payload: { text: 'Namaste, this is Asha.' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe('audio/wav');
    expect(response.headers['x-ovo-preview-characters']).toBe('22');
    const wav = response.rawPayload;
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM, which every browser plays
    expect(wav.readUInt32LE(24)).toBe(8000); // the telephone band a caller hears
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.byteLength).toBeGreaterThan(44 + 100);
    expect(resolved).toEqual(['cred-1']);
    expect(audits).toEqual([
      {
        workspaceId: 'ws',
        actorId: 'operator',
        action: 'provider-binding.preview',
        resourceType: 'provider-binding',
        resourceId: 'tts-1',
        payload: { pluginId: '@winsendotai/ovo-provider-openai-tts', characters: 22 },
      },
    ]);
    net.assertComplete();
    await app.close();
  });

  it('uses the default line when none is given', async () => {
    const net = createFixtureNet(
      openAiTtsTemplate({
        format: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 },
        language: 'en',
        sessionId: 'preview',
        turns: [],
        agentTexts: [DEFAULT_PREVIEW_TEXT],
      }),
    );
    const { app } = build(net, [binding()]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-bindings/tts-1/preview',
    });
    expect(response.statusCode, response.body).toBe(200);
    await app.close();
  });

  it('refuses a missing binding and a binding that is not a TTS', async () => {
    const stt = binding({
      id: 'stt-1',
      provider: 'elevenlabs',
      pluginId: '@winsendotai/ovo-stt-elevenlabs',
      config: {},
    });
    const { app, audits } = build(createFixtureNet([]), [stt]);
    const missing = await app.inject({ method: 'POST', url: '/v1/provider-bindings/nope/preview' });
    expect(missing.statusCode).toBe(404);
    const notTts = await app.inject({ method: 'POST', url: '/v1/provider-bindings/stt-1/preview' });
    expect(notTts.statusCode).toBe(409);
    expect(notTts.json().error.code).toBe('binding_not_tts');
    expect(audits).toEqual([]);
    await app.close();
  });

  it('reports a provider failure as a bad gateway and audits nothing', async () => {
    const net = createFixtureNet([
      {
        host: 'api.openai.com',
        source: 'https://platform.openai.com/docs/api-reference/audio/createSpeech',
        retrieved: '2026-09-25',
        steps: [
          {
            expect: 'http',
            method: 'POST',
            url: 'https://api.openai.com/v1/audio/speech',
            reply: { status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) },
          },
        ],
      },
    ]);
    const { app, audits } = build(net, [binding()]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-bindings/tts-1/preview',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('preview_failed');
    expect(audits).toEqual([]);
    await app.close();
  });

  it('rejects text beyond the preview limit', async () => {
    const { app } = build(createFixtureNet([]), [binding()]);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-bindings/tts-1/preview',
      payload: { text: 'x'.repeat(301) },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

it('is served by the management API beside the other binding routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-binding-preview-'));
  const headers = { authorization: 'Bearer fixture-operator' };
  const { app } = await buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
    sessionSecret: 'binding-preview-session-secret',
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
  const post = (url: string, payload?: object) =>
    app.inject({ method: 'POST', url, headers, ...(payload ? { payload } : {}) });
  try {
    const credential = await post('/v1/credentials', {
      label: 'assemblyai credential',
      provider: 'assemblyai',
      type: 'api-key',
      environment: 'test',
      value: 'synthetic-fixture-only',
    });
    const stt = await post('/v1/provider-bindings', {
      label: 'stt',
      provider: 'assemblyai',
      pluginId: '@winsendotai/ovo-stt-assemblyai',
      environment: 'test',
      credentialId: credential.json().id,
      config: {},
    });
    expect(stt.statusCode, stt.body).toBe(201);
    const preview = await post(`/v1/provider-bindings/${stt.json().id}/preview`);
    expect(preview.statusCode, preview.body).toBe(409);
    expect(preview.json().error.code).toBe('binding_not_tts');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
