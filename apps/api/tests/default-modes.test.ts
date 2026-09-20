import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { buildManagementApi } from '../src/server.ts';

it('creates, validates, publishes and runs all four modes through the default API graph', async () => {
  const directory = await mkdtemp('/var/tmp/ovo-default-modes-');
  let effects = 0;
  const { app, composition } = await buildManagementApi({
    databaseFile: join(directory, 'store.sqlite'),
    secretsMasterKey: Buffer.alloc(32, 7).toString('base64'),
    sessionSecret: 'fixture-session-secret',
    requireTlsForSecrets: false,
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'fixture-token',
        defaultWorkspaceId: 'local',
        workspaces: { local: 'admin' },
      },
    ],
    defaultSession: {
      nativeHandlers: {
        check: async () => {
          effects++;
          return { ok: true };
        },
      },
      nativeHandlerPackages: [
        {
          packageName: 'fixture-native-tools',
          packageVersion: '1.0.0',
          pluginId: 'fixture-native-tools/native-handlers',
          pluginVersion: '1.0.0',
          handlerIds: ['check'],
        },
      ],
      inferencePlugin: (agent) =>
        definePlugin(
          {
            id: 'fixture.inference',
            version: '1.0.0',
            contractVersion: 1,
            scope: 'session',
            requires: [],
            provides: ['ovo.inference'],
            configSchema: {},
            secretFields: [],
          },
          (ctx) => {
            ctx.provide('ovo.inference', {
              generate: async (request: { results: unknown[] }) =>
                agent.config.mode === 'agent' && !request.results.length
                  ? { kind: 'tool', toolId: 'check', input: {} }
                  : { kind: 'text', text: 'Fixture answer.' },
            });
          },
        ),
    },
  });
  const headers = { authorization: 'Bearer fixture-token' };
  const post = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers, payload: payload as object });
  try {
    const credential = await post('/v1/credentials', {
      label: 'OpenAI fixture',
      provider: 'openai',
      type: 'api-key',
      environment: 'test',
      value: 'never-sent-over-network',
    });
    expect(credential.statusCode, credential.body).toBe(201);
    const binding = await post('/v1/provider-bindings', {
      label: 'Inference',
      provider: 'openai',
      environment: 'test',
      credentialId: credential.json().id,
      config: { model: 'fixture-model', api: 'responses' },
    });
    expect(binding.statusCode, binding.body).toBe(201);
    for (const mode of ['announcement', 'faq', 'context', 'agent'] as const) {
      const created = await post('/v1/agents', {
        config: {
          name: mode,
          mode,
          message: 'Hello.',
          context: 'Fixture facts.',
          faq: [{ id: 'question', question: 'check', answer: 'FAQ answer.' }],
          providers: ['context', 'agent'].includes(mode) ? { inference: binding.json().id } : {},
          tools:
            mode === 'agent'
              ? [
                  {
                    id: 'check',
                    description: 'Fixture check',
                    connector: 'native',
                    effect: 'read',
                    inputSchema: { type: 'object' },
                  },
                ]
              : [],
          allowedTools: mode === 'agent' ? ['check'] : [],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const agentId = created.json().id;
      const ready = await app.inject({
        method: 'GET',
        url: `/v1/agents/${agentId}/readiness`,
        headers,
      });
      expect(ready.json().releaseReady, ready.body).toBe(true);
      const release = await post(`/v1/agents/${agentId}/releases`, {});
      expect(release.statusCode, release.body).toBe(201);
      const simulation = await post('/v1/simulations', {
        releaseId: release.json().id,
        input: 'check',
        variables: {},
      });
      expect(simulation.statusCode, simulation.body).toBe(200);
      expect(simulation.json()).toMatchObject({
        kind: 'simulation',
        output:
          mode === 'announcement' ? 'Hello.' : mode === 'faq' ? 'FAQ answer.' : 'Fixture answer.',
      });
      if (mode === 'context')
        expect(release.json().providerBindings.inference.config.model).toBe('fixture-model');
      if (mode === 'agent') {
        expect(release.json().plugins).toContainEqual({
          id: 'fixture-native-tools/native-handlers',
          version: '1.0.0',
        });
        const writeAgent = await post('/v1/agents', {
          config: {
            ...created.json().config,
            name: 'Write fixture',
            tools: [{ ...created.json().config.tools[0], effect: 'write', confirmation: true }],
          },
        });
        expect(writeAgent.statusCode, writeAgent.body).toBe(201);
        const writeRelease = await post(`/v1/agents/${writeAgent.json().id}/releases`, {});
        expect(writeRelease.statusCode, writeRelease.body).toBe(201);
        const unsafe = await post('/v1/simulations', {
          releaseId: writeRelease.json().id,
          input: 'change',
          variables: { confirmed: true },
        });
        expect(unsafe.statusCode, unsafe.body).toBe(422);
        const safe = await post('/v1/simulations', {
          releaseId: writeRelease.json().id,
          input: 'change',
          followUpInputs: ['yes'],
          bindings: {
            modelReplies: [
              { kind: 'tool', toolId: 'check', input: {} },
              { kind: 'text', text: 'Simulated change only.' },
            ],
            toolResults: { check: { ok: true } },
          },
        });
        expect(safe.statusCode, safe.body).toBe(200);
        expect(safe.json().output).toBe('Simulated change only.');
      }
    }
    expect(effects).toBe(1);
  } finally {
    await composition.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
