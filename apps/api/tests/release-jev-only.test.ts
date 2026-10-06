import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { buildManagementApi } from '../src/server.ts';

const headers = { authorization: 'Bearer fixture-operator' };

/** Every outcome speaks, and an unavailable decision has its line: no path reaches an LLM. */
const decision = {
  enabled: true,
  state: { sources: ['last-turn'] },
  questions: [
    {
      id: 'intent',
      type: 'choice',
      instructions: 'What does the caller want?',
      threshold: 0.6,
      fallback: 'clarify',
      options: [
        { key: 'pay', description: 'Wants to pay.', outcome: { say: 'Thank you.' } },
        { key: 'bye', description: 'Wants to go.', outcome: { say: 'Goodbye.', end: true } },
      ],
    },
  ],
};

it('publishes a Jev-only agent with no LLM binding (AGT-4)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ovo-release-jev-only-'));
  const { app, composition } = await buildManagementApi({
    databaseFile: join(directory, 'control.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
    sessionSecret: 'release-jev-only-session-secret',
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
    const voice = {
      carrier: {
        plugin: '@winsendotai/ovo-carrier-twilio',
        binding: await bind('twilio', '@winsendotai/ovo-carrier-twilio', {
          accountSid: `AC${'0'.repeat(32)}`,
        }),
        config: {},
      },
      stt: {
        plugin: '@winsendotai/ovo-stt-assemblyai',
        binding: await bind('assemblyai', '@winsendotai/ovo-stt-assemblyai', {}),
        config: {},
      },
      tts: {
        plugin: '@winsendotai/ovo-provider-openai-tts',
        binding: await bind('openai', '@winsendotai/ovo-provider-openai-tts', {
          model: 'gpt-4o-mini-tts',
          voice: 'alloy',
        }),
        config: {},
      },
      decision: {
        plugin: '@winsendotai/ovo-decision-jev',
        binding: await bind('typesafe', '@winsendotai/ovo-decision-jev', {
          calibrationLabel: 'release-test',
        }),
        config: {},
      },
    };
    const create = (extra: object) =>
      post('/v1/agents', {
        config: { name: 'Jev-only release', mode: 'agent', decision, voice, ...extra },
      });
    const jevOnly = await create({ decisionUnavailable: { line: 'Sorry, one moment.' } });
    expect(jevOnly.statusCode, jevOnly.body).toBe(201);
    const release = await post(`/v1/agents/${jevOnly.json().id}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    expect(release.json().selections.llm).toBeUndefined();
    expect(release.json().selections.decision).toMatchObject({
      pluginId: '@winsendotai/ovo-decision-jev',
    });

    // The same agent without the unavailable line falls through to an LLM, so it cannot publish.
    const reachable = await create({});
    expect(reachable.statusCode, reachable.body).toBe(201);
    const refused = await post(`/v1/agents/${reachable.json().id}/releases`, {});
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().blockers).toEqual([
      expect.objectContaining({
        code: 'binding_missing',
        message: 'An inference binding is required',
      }),
    ]);
  } finally {
    await composition.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
