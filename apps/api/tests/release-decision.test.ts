import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

const headers = { authorization: 'Bearer fixture-operator' };

it('pins a decision plugin and a real Twilio binding into the release', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-release-decision-'));
  const { app, composition } = await buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
    sessionSecret: 'release-decision-session-secret',
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
  const post = (url: string, payload: object) =>
    app.inject({ method: 'POST', url, headers, payload });
  try {
    const bind = async (provider: string, pluginId: string, config: object) => {
      const credential = await post('/v1/credentials', {
        label: `${provider} credential`,
        provider,
        type: 'api-key',
        environment: 'test',
        value: 'synthetic-fixture-only',
      });
      expect(credential.statusCode, credential.body).toBe(201);
      const binding = await post('/v1/provider-bindings', {
        label: `${provider} binding`,
        provider,
        pluginId,
        environment: 'test',
        credentialId: credential.json().id,
        config,
      });
      expect(binding.statusCode, binding.body).toBe(201);
      return binding.json().id as string;
    };
    const twilio = await bind('twilio', '@winsendotai/ovo-carrier-twilio', {
      accountSid: `AC${'0'.repeat(32)}`,
    });
    const stt = await bind('assemblyai', '@winsendotai/ovo-stt-assemblyai', {});
    const tts = await bind('openai', '@winsendotai/ovo-provider-openai-tts', {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
    });
    const llm = await bind('openai', '@winsendotai/ovo-provider-openai-inference', {
      model: 'gpt-4.1-mini',
    });
    const decision = await bind('typesafe', '@winsendotai/ovo-decision-jev', {
      calibrationLabel: 'release-test',
    });
    const agent = await post('/v1/agents', {
      config: {
        name: 'Decision release',
        mode: 'agent',
        context: 'You are a test agent.',
        decision: {
          enabled: true,
          state: { sources: ['last-turn'] },
          questions: [
            {
              id: 'intent',
              type: 'choice',
              instructions: 'What does the caller want?',
              threshold: 0.6,
              fallback: 'llm',
              options: [
                { key: 'pay', description: 'Wants to pay.', outcome: {} },
                { key: 'other', description: 'Anything else.', outcome: {} },
              ],
            },
          ],
        },
        voice: {
          carrier: { plugin: '@winsendotai/ovo-carrier-twilio', binding: twilio, config: {} },
          stt: { plugin: '@winsendotai/ovo-stt-assemblyai', binding: stt, config: {} },
          tts: { plugin: '@winsendotai/ovo-provider-openai-tts', binding: tts, config: {} },
          llm: { plugin: '@winsendotai/ovo-provider-openai-inference', binding: llm, config: {} },
          decision: { plugin: '@winsendotai/ovo-decision-jev', binding: decision, config: {} },
        },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const release = await post(`/v1/agents/${agent.json().id}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    expect(release.json().selections).toMatchObject({
      carrier: { pluginId: '@winsendotai/ovo-carrier-twilio', bindingId: twilio },
      decision: { pluginId: '@winsendotai/ovo-decision-jev', bindingId: decision },
    });
  } finally {
    await composition.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
