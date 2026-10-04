import { expect, it } from 'vitest';
import { Cap } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { buildManagementApi } from '../src/server.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

it('keeps script state across simulated turns and stops after confirmed terminal playback', async () => {
  const { app, composition } = await buildManagementApi({
    databaseFile: ':memory:',
    secretBackend: 'local',
    sessionSecret: 'script-fixture-session',
    secretsMasterKey: Buffer.alloc(32, 5).toString('base64'),
    pluginCatalog: [selectedSpeechFixture],
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'script-fixture-token',
        defaultWorkspaceId: 'local',
        workspaces: { local: 'admin' },
      },
    ],
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer script-fixture-token' },
      payload: payload as Record<string, unknown>,
    });
  try {
    const agent = await post('/v1/agents', {
      config: {
        name: 'Multi-turn script',
        mode: 'faq',
        faq: [{ id: 'hours', question: 'opening hours', answer: 'Nine to five.' }],
        voice: selectedSpeechVoice,
        script: {
          start: 'start',
          nodes: [
            {
              id: 'start',
              prompt: 'Say continue.',
              transitions: [{ event: 'text', matches: ['continue'], to: 'done' }],
            },
            { id: 'done', prompt: 'Thank you.', terminal: true },
          ],
        },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const release = await post(`/v1/agents/${agent.json().id}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    const simulation = await post('/v1/simulations', {
      releaseId: release.json().id,
      input: 'start',
      followUpInputs: ['opening hours', 'continue', 'must not execute'],
      bindings: {},
    });
    expect(simulation.statusCode, simulation.body).toBe(200);
    expect(simulation.json().output).toBe('Thank you.');
    const store = composition.ctx.get('controlStore') as ControlStore;
    const events = await store.listCallEvents('local', simulation.json().callId, 50);
    expect(
      events.items
        .filter((event) => event.type === 'simulation.output')
        .map((event) => event.payload.text),
    ).toEqual(['Say continue.', 'Nine to five. Say continue.', 'Thank you.']);
    expect(events.items.some((event) => event.payload.input === 'must not execute')).toBe(false);
    const evidence = await app.inject({
      method: 'GET',
      url: `/v1/calls/${simulation.json().callId}/evidence`,
      headers: { authorization: 'Bearer script-fixture-token' },
    });
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(
      evidence
        .json()
        .transcript.map((line: { type: string; text: string }) => [line.type, line.text]),
    ).toEqual([
      ['transcript.user.final', 'start'],
      ['transcript.agent.generated', 'Say continue.'],
      ['transcript.user.final', 'opening hours'],
      ['transcript.agent.generated', 'Nine to five. Say continue.'],
      ['transcript.user.final', 'continue'],
      ['transcript.agent.generated', 'Thank you.'],
    ]);
  } finally {
    await composition.dispose();
  }
});

it('composes the selected LLM from a published voice release through the simulation route', async () => {
  const llm = definePlugin(
    {
      id: '@fixture/selected-llm',
      version: '1.0.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'llm',
      provider: 'fixture',
      provides: [`${Cap.inference}@2`],
      requires: [],
      configSchema: { type: 'object' },
      secretFields: [],
      capabilities: {
        languages: ['*'],
        interim: false,
        wordTimestamps: false,
        turnSignals: [],
        forceEndpoint: false,
      },
      meters: [{ key: 'fixture.input_tokens', unit: 'input_tokens', label: 'Tokens', role: 'llm' }],
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['llm@1'],
    },
    (ctx) => {
      ctx.provide(Cap.inference, {
        generate: async () => ({ kind: 'text', text: 'Selected LLM response' }),
      });
    },
  );
  const { app, composition } = await buildManagementApi({
    databaseFile: ':memory:',
    secretBackend: 'local',
    sessionSecret: 'selected-llm-simulation',
    secretsMasterKey: Buffer.alloc(32, 5).toString('base64'),
    pluginCatalog: [llm, selectedSpeechFixture],
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'selected-llm-token',
        defaultWorkspaceId: 'local',
        workspaces: { local: 'admin' },
      },
    ],
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer selected-llm-token' },
      payload: payload as Record<string, unknown>,
    });
  try {
    const agent = await post('/v1/agents', {
      config: {
        name: 'Voice LLM simulation',
        mode: 'context',
        context: 'Fixture facts.',
        voice: {
          ...selectedSpeechVoice,
          llm: { plugin: llm.manifest.id, binding: 'env', config: {} },
        },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const release = await post(`/v1/agents/${agent.json().id}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    expect(release.json().selections.llm.pluginId).toBe(llm.manifest.id);
    const simulation = await post('/v1/simulations', {
      releaseId: release.json().id,
      input: 'Hello',
      bindings: {},
    });
    expect(simulation.statusCode, simulation.body).toBe(200);
    expect(simulation.json().output).toBe('Selected LLM response');
  } finally {
    await composition.dispose();
  }
});

it('simulates a published release selecting the installed OpenAI LLM with explicit fixture replies', async () => {
  const llm = '@winsendotai/ovo-provider-openai-inference';
  const tts = '@winsendotai/ovo-provider-openai-tts';
  const stt = '@winsendotai/ovo-provider-deepgram-stt';
  const distribution = await loadDistribution({ role: 'api', profile: 'compose', env: {} });
  const { app, composition } = await buildManagementApi({
    databaseFile: ':memory:',
    loadedDistribution: distribution,
    secretBackend: 'local',
    sessionSecret: 'real-llm-simulation',
    secretsMasterKey: Buffer.alloc(32, 5).toString('base64'),
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'real-llm-simulation-token',
        defaultWorkspaceId: 'local',
        workspaces: { local: 'admin' },
      },
    ],
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer real-llm-simulation-token' },
      payload: payload as Record<string, unknown>,
    });
  try {
    const binding = async (provider: string, pluginId: string, config: object) => {
      const credential = await post('/v1/credentials', {
        label: `${provider} fixture credential`,
        provider,
        type: 'api-key',
        environment: 'test',
        value: 'never-sent',
      });
      expect(credential.statusCode, credential.body).toBe(201);
      const result = await post('/v1/provider-bindings', {
        label: `${provider} fixture binding`,
        provider,
        pluginId,
        environment: 'test',
        credentialId: credential.json().id,
        config,
      });
      expect(result.statusCode, result.body).toBe(201);
      return result.json().id as string;
    };
    const llmBinding = await binding('openai', llm, { model: 'gpt-4o-mini' });
    const ttsBinding = await binding('openai', tts, { model: 'tts-1', voice: 'alloy' });
    const sttBinding = await binding('deepgram', stt, { model: 'nova-2' });
    const agent = await post('/v1/agents', {
      config: {
        name: 'Published voice LLM simulation',
        mode: 'context',
        context: 'Reference facts.',
        voice: {
          engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
          llm: { plugin: llm, binding: llmBinding, config: {} },
          tts: { plugin: tts, binding: ttsBinding, config: {} },
          stt: { plugin: stt, binding: sttBinding, config: {} },
        },
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const released = await post(`/v1/agents/${agent.json().id}/releases`, {});
    expect(released.statusCode, released.body).toBe(201);
    expect(released.json().selections.llm.pluginId).toBe(llm);
    const simulated = await post('/v1/simulations', {
      releaseId: released.json().id,
      input: 'Hello',
      bindings: {
        modelReplies: [{ kind: 'text', text: 'Fixture reply without provider traffic' }],
      },
    });
    expect(simulated.statusCode, simulated.body).toBe(200);
    expect(simulated.json().output).toBe('Fixture reply without provider traffic');
  } finally {
    await composition.dispose();
  }
});
