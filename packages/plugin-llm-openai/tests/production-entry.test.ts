import { expect, it } from 'vitest';
import {
  AgentConfig,
  Cap,
  MULAW_8K,
  type Inference,
  type MediaDuplex,
  type SpeechToText,
  type TextToSpeech,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin, PluginRegistry } from '@winsendotai/ovo-runtime';
import { loadDistribution } from '../../distribution/src/load.ts';
import { selectSessionGraph } from '../../session-host/src/select-session-graph.ts';
import { openAiInferencePlugin } from '../src/index.ts';
import { openAiGenerateTemplate } from '../src/testing.ts';

it('selects all three v2 providers from distribution and calls OpenAI through the host NetPort', async () => {
  const sttId = '@winsendotai/ovo-provider-deepgram-stt';
  const ttsId = '@winsendotai/ovo-provider-openai-tts';
  const tool: ToolDefinition = {
    id: 'book_slot',
    description: 'Book a slot',
    connector: 'native',
    effect: 'write',
    confirmation: true,
    timeoutMs: 1000,
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
  };
  const loaded = await loadDistribution({
    role: 'gateway',
    profile: 'compose',
    env: {},
  });
  const selectedDefinition = loaded.catalog.find(
    (item) => item.manifest.id === openAiInferencePlugin.manifest.id,
  );
  if (!selectedDefinition || selectedDefinition.manifest.contractVersion !== 2)
    throw new Error('The distribution did not select the v2 OpenAI provider');
  // Five token meters, plus the web search meter that applies only when a binding enables it.
  expect(selectedDefinition.manifest.meters).toHaveLength(6);

  const net = createFixtureNet(
    openAiGenerateTemplate({
      format: MULAW_8K,
      language: 'en',
      sessionId: 'selected',
      turns: [{ atMs: 0, say: 'book' }],
      tools: [{ id: tool.id, inputSchema: tool.inputSchema, effect: 'write' }],
    }),
  );
  const resolvedSecrets: string[] = [];
  const secretHost = definePlugin(
    {
      id: 'fixture-session-secrets',
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [Cap.secrets],
      configSchema: { type: 'object' },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, {
        resolve: async (workspaceId: string, credentialId: string) => {
          resolvedSecrets.push(`${workspaceId}/${credentialId}`);
          return 'fixture-key';
        },
      });
    },
  );
  const selected = selectSessionGraph({
    release: {
      id: 'release',
      workspaceId: 'workspace',
      config: AgentConfig.parse({ name: 'Context', mode: 'context' }),
      plugins: [],
      selections: {
        stt: { pluginId: sttId, version: '0.1.0', bindingId: 'stt-binding', config: {} },
        tts: { pluginId: ttsId, version: '0.1.0', bindingId: 'tts-binding', config: {} },
        llm: {
          pluginId: openAiInferencePlugin.manifest.id,
          version: '0.1.0',
          bindingId: 'llm-binding',
          config: {},
        },
      },
      providerBindings: {
        stt: {
          id: 'stt-binding',
          provider: 'deepgram',
          config: { model: 'nova-3' },
          credentialId: 'stt-credential',
        },
        tts: {
          id: 'tts-binding',
          provider: 'openai',
          config: { model: 'tts-1', voice: 'alloy' },
          credentialId: 'tts-credential',
        },
        inference: {
          id: 'llm-binding',
          provider: 'openai',
          config: { model: 'gpt-4o-mini' },
          credentialId: 'credential',
        },
      },
    },
    registry: new PluginRegistry(loaded.catalog),
    hostServices: [],
    parent: [],
    media: {
      sessionId: 'selected',
      carrierId: 'fixture',
      format: MULAW_8K,
      playbackEvidence: 'carrier-played',
    } as MediaDuplex,
    installedExtensions: { plugins: [], nativeHandlers: {} },
  });
  expect(selected.resolved.llm.id).toBe(openAiInferencePlugin.manifest.id);
  expect(selected.resolved.stt.id).toBe(sttId);
  expect(selected.resolved.tts.id).toBe(ttsId);
  for (const [id, credentialId] of [
    [sttId, 'stt-credential'],
    [ttsId, 'tts-credential'],
  ] as const)
    expect(selected.rows.find((row) => row.id === id)?.config).toMatchObject({
      credentialRef: { credentialId },
    });
  const providerRow = selected.rows.find((row) => row.id === openAiInferencePlugin.manifest.id);
  expect(providerRow?.config).toMatchObject({
    binding: { model: 'gpt-4o-mini' },
    credentialRef: { credentialId: 'credential' },
  });

  const graph = await compose(
    [{ id: secretHost.manifest.id }, ...selected.rows],
    [secretHost, ...selected.catalog],
    { scope: 'session', workspaceId: 'workspace', net },
  );
  try {
    expect((graph.get(Cap.stt) as SpeechToText).capabilities.inputFormats).toContainEqual(MULAW_8K);
    expect((graph.get(Cap.tts) as TextToSpeech).capabilities.outputFormats).toHaveLength(1);
    const inference = graph.get(Cap.inference) as Inference;
    const request = {
      input: 'book',
      context: 'Reserve a table.',
      uncertainty: 'unknown',
      tools: [tool],
      results: [],
      signal: new AbortController().signal,
    };
    expect(await inference.generate(request)).toMatchObject({ kind: 'tool', toolId: 'book_slot' });
    expect(await inference.generate({ ...request, input: 'booked' })).toMatchObject({
      kind: 'text',
      text: 'The table is booked.',
    });
    expect(resolvedSecrets.sort()).toEqual([
      'workspace/credential',
      'workspace/stt-credential',
      'workspace/tts-credential',
    ]);
    expect(graph.get(Cap.behavior)).toBeDefined();
    expect(graph.violations).toEqual([]);
    net.assertComplete();
  } finally {
    await graph.dispose();
  }
});
