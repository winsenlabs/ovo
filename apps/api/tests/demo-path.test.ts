import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { TestCallRuntime } from '@winsendotai/ovo-fixture-calls';
import { buildManagementApi } from '../src/server.ts';
import { executeFixtureChildJob } from '../src/test-call-runtime.ts';

const twilio = '@winsendotai/ovo-carrier-twilio';
const openai = '@winsendotai/ovo-provider-openai-tts';
const headers = { authorization: 'Bearer fixture-operator' };

it('creates an agent, pins selections, checks compat, runs a real-plugin fixture call and reads evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-i1-demo-'));
  const { app, composition } = await buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 6).toString('base64'),
    sessionSecret: 'i1-demo-session-secret',
    requireTlsForSecrets: false,
    testCallRuntime: new TestCallRuntime({ enabled: true, execute: executeFixtureChildJob }),
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
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers, payload });
  try {
    const bind = async (provider: string, pluginId: string, config: object) => {
      const credential = await post('/v1/credentials', {
        label: `${provider} fixture credential`,
        provider,
        type: 'api-key',
        environment: 'test',
        value: 'synthetic-fixture-only',
      });
      expect(credential.statusCode, credential.body).toBe(201);
      const binding = await post('/v1/provider-bindings', {
        label: `${provider} fixture binding`,
        provider,
        pluginId,
        environment: 'test',
        credentialId: credential.json().id,
        config,
      });
      expect(binding.statusCode, binding.body).toBe(201);
      return binding.json().id as string;
    };
    const ttsBinding = await bind('openai', openai, { model: 'gpt-4o-mini-tts', voice: 'alloy' });
    const agent = await post('/v1/agents', {
      config: {
        name: 'Integration announcement',
        mode: 'announcement',
        language: 'en-IN',
        recording: false,
        message: 'Fixture answer.',
        voice: {
          engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
          carrier: { plugin: twilio, binding: 'env', config: {} },
          tts: { plugin: openai, binding: ttsBinding, config: {} },
        },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const agentId = agent.json().id as string;
    const compat = await post('/v1/plugins/compat', {
      mode: 'announcement',
      language: 'en-IN',
      tools: [],
      voice: agent.json().config.voice,
    });
    expect(compat.statusCode, compat.body).toBe(200);
    expect(compat.json()).toContainEqual(
      expect.objectContaining({
        code: 'meter_uncovered',
        field: 'openai.streaming-tts.input_tokens',
        stage: 'live',
      }),
    );
    const release = await post(`/v1/agents/${agentId}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    expect(release.json().selections).toMatchObject({
      carrier: { pluginId: twilio },
      tts: { pluginId: openai },
    });
    const started = await post(`/v1/agents/${agentId}/test-calls`, {
      releaseId: release.json().id,
      callerScript: { turns: [] },
    });
    expect(started.statusCode, started.body).toBe(202);
    const callId = started.json().callId as string;
    await vi.waitFor(
      async () => {
        const call = await app.inject({ method: 'GET', url: `/v1/calls/${callId}`, headers });
        if (call.json().status === 'failed') {
          const events = await app.inject({
            method: 'GET',
            url: `/v1/calls/${callId}/events`,
            headers,
          });
          throw new Error(JSON.stringify(events.json()));
        }
        expect(call.json().status).toBe('completed');
      },
      { timeout: 15_000 },
    );
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/evidence`,
      headers,
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.body).toContain('Fixture answer.');
    expect(evidence.body).not.toContain('synthetic-fixture-only');
  } finally {
    await composition.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
