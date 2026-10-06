import { expect, it } from 'vitest';
import { Cap, type InferenceRequest } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { buildManagementApi } from '../src/server.ts';
import { selectedSpeechFixture, selectedSpeechVoice } from './selected-speech-fixture.ts';

function recordingLlm() {
  const requests: InferenceRequest[] = [];
  const plugin = definePlugin(
    {
      id: '@fixture/opening-llm',
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
        generate: async (request: InferenceRequest) => {
          requests.push(request);
          return { kind: 'text', text: 'Thanks for confirming.' };
        },
      });
    },
  );
  return { plugin, requests };
}

async function simulate(config: Record<string, unknown>, input: string) {
  const llm = recordingLlm();
  const { app, composition } = await buildManagementApi({
    databaseFile: ':memory:',
    secretBackend: 'local',
    sessionSecret: 'opening-simulation',
    secretsMasterKey: Buffer.alloc(32, 5).toString('base64'),
    pluginCatalog: [llm.plugin, selectedSpeechFixture],
    identities: [
      {
        id: 'operator',
        label: 'Operator',
        token: 'opening-simulation-token',
        defaultWorkspaceId: 'local',
        workspaces: { local: 'admin' },
      },
    ],
  });
  const post = (url: string, payload: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer opening-simulation-token' },
      payload: payload as Record<string, unknown>,
    });
  try {
    const agent = await post('/v1/agents', {
      config: {
        name: 'Greet-first simulation',
        mode: 'agent',
        context: 'Fixture facts.',
        variables: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
          additionalProperties: false,
        },
        voice: {
          ...selectedSpeechVoice,
          llm: { plugin: llm.plugin.manifest.id, binding: 'env', config: {} },
        },
        ...config,
      },
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const release = await post(`/v1/agents/${agent.json().id}/releases`, {});
    expect(release.statusCode, release.body).toBe(201);
    const simulation = await post('/v1/simulations', {
      releaseId: release.json().id,
      input,
      variables: { name: 'Ravi' },
      bindings: {},
    });
    expect(simulation.statusCode, simulation.body).toBe(200);
    const store = composition.ctx.get('controlStore') as ControlStore;
    const events = await store.listCallEvents('local', simulation.json().callId, 50);
    const outputs = events.items
      .filter((event) => event.type === 'simulation.output')
      .map((event) => [event.payload.epoch, event.payload.text]);
    return { output: simulation.json().output as string, outputs, requests: llm.requests };
  } finally {
    await composition.dispose();
  }
}

it('speaks a greet-first opening before the first simulated caller turn', async () => {
  const result = await simulate(
    { opening: { lines: ['Hello, this is Asha.', 'Am I speaking with {{name}}?'] } },
    'yes speaking',
  );
  expect(result.outputs).toEqual([
    [0, 'Hello, this is Asha. Am I speaking with Ravi?'],
    [1, 'Thanks for confirming.'],
  ]);
  expect(result.output).toBe('Thanks for confirming.');
  // Each opening line was played (a simulated receipt) before the caller answered, so the LLM
  // sees what the caller is replying to.
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]!.history).toEqual([
    { role: 'assistant', content: '[Playback evidence: simulated.] Hello, this is Asha.' },
    { role: 'assistant', content: '[Playback evidence: simulated.] Am I speaking with Ravi?' },
  ]);
});

it('leaves an agent without an opening answering the first input', async () => {
  const result = await simulate({}, 'hello');
  expect(result.outputs).toEqual([[0, 'Thanks for confirming.']]);
  expect(result.requests[0]!.history).toEqual([]);
});
