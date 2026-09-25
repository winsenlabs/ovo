import { expect, it } from 'vitest';
import { Cap, MULAW_8K, type Inference, type ToolDefinition } from '@winsendotai/ovo-contracts';
import { schemaFailures } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { openAiInferencePlugin } from '../src/index.ts';
import { openAiInference } from '../src/inference.ts';
import { fixtures, openAiGenerateTemplate, openAiStreamTemplate } from '../src/testing.ts';

const wireTool: ToolDefinition = {
  id: 'book_slot', description: 'Book a slot', connector: 'native', effect: 'write',
  confirmation: true, timeoutMs: 1000,
  inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
};
const fixtureInput = {
  format: MULAW_8K, language: 'en', sessionId: 'fixture',
  turns: [{ atMs: 0, say: 'book' }],
  tools: [{ id: wireTool.id, inputSchema: wireTool.inputSchema, effect: 'write' as const }],
};
const request = {
  input: 'book', context: 'Reserve a table.', uncertainty: 'unknown' as const,
  tools: [wireTool], results: [], signal: new AbortController().signal,
};

it('renders schema-valid enum and nested write-tool arguments through the real SDK', async () => {
  const tool: ToolDefinition = {
    id: 'book_slot', description: 'Book a slot', connector: 'native', effect: 'write',
    confirmation: true, timeoutMs: 1000,
    inputSchema: {
      type: 'object', required: ['mode', 'details'], additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['book', 'cancel'] },
        details: { type: 'object', required: ['party'], additionalProperties: false,
          properties: { party: { type: 'integer', minimum: 3 } } },
      },
    },
  };
  const net = createFixtureNet(openAiGenerateTemplate({
    format: MULAW_8K, language: 'en', sessionId: 'fixture', turns: [{ atMs: 0, say: 'book' }],
    tools: [{ id: tool.id, inputSchema: tool.inputSchema, effect: 'write' }],
  }));
  const inference = openAiInference(net, 'fixture-key', { model: 'gpt-4o-mini' });
  const first = await inference.generate({
    input: 'book', context: 'Reserve a table.', uncertainty: 'unknown', tools: [tool], results: [],
    signal: new AbortController().signal,
  });
  expect(first).toMatchObject({ kind: 'tool', toolId: 'book_slot', input: { mode: 'book', details: { party: 3 } } });
  if (first.kind !== 'tool') throw new Error('Expected a tool call');
  expect(schemaFailures(tool, first.input)).toEqual([]);
  // This test intentionally consumes just the first HTTP step. The second is for the next turn.
  expect(net.mismatches).toEqual([]);
});

it.each([
  ['generate', openAiGenerateTemplate],
  ['stream', openAiStreamTemplate],
] as const)('sends temperature and max output tokens on the %s wire request', async (mode, template) => {
  const net = createFixtureNet(template(fixtureInput));
  const inference = openAiInference(net, 'fixture-key', {
    model: 'gpt-4o-mini', temperature: 0.3, maxOutputTokens: 91,
  });
  if (mode === 'generate') await inference.generate(request);
  else for await (const _event of inference.stream(request)) { /* consume first step */ }
  const sent = JSON.parse(String(net.log.find((entry) => entry.kind === 'http')?.data)) as Record<string, unknown>;
  expect(sent.temperature).toBe(0.3);
  expect(sent.max_output_tokens).toBe(91);
  expect(net.mismatches).toEqual([]);
});

it('composes the v2 provider, resolves its workspace credential, and uses the host NetPort', async () => {
  const net = createFixtureNet(openAiGenerateTemplate(fixtureInput));
  const resolved: string[] = [];
  const host = definePlugin({
    id: 'fixture-secret-host', version: '0.1.0', contractVersion: 1, scope: 'session',
    requires: [], provides: [Cap.secrets], configSchema: { type: 'object' }, secretFields: [],
  }, (ctx) => {
    ctx.provide(Cap.secrets, { resolve: async (workspace: string, credential: string) => {
      resolved.push(`${workspace}/${credential}`);
      return 'fixture-key';
    } });
  });
  const graph = await compose([
    { id: host.manifest.id },
    { id: openAiInferencePlugin.manifest.id, config: {
      binding: { model: 'gpt-4o-mini' },
      credentialRef: { credentialRef: { credentialId: 'cred-1' } },
    } },
  ], [host, openAiInferencePlugin], { scope: 'session', workspaceId: 'w1', net });
  try {
    const inference = graph.get(Cap.inference) as Inference;
    expect(await inference.generate(request)).toMatchObject({ kind: 'tool', toolId: 'book_slot' });
    expect(resolved).toEqual(['w1/cred-1']);
    expect(graph.violations).toEqual([]);
    expect(net.mismatches).toEqual([]);
  } finally { await graph.dispose(); }
});

it('ships a representative two-turn fixture that produces a valid write-tool call', async () => {
  const id = '@winsendotai/ovo-provider-openai-inference';
  const script = fixtures[id];
  expect(script).toHaveLength(1);
  const net = createFixtureNet(script!);
  const tool: ToolDefinition = {
    ...wireTool, id: 'book_table', inputSchema: {
      type: 'object', required: ['party', 'time'], additionalProperties: false,
      properties: { party: { type: 'integer', minimum: 1 }, time: { type: 'string', minLength: 1 } },
    },
  };
  const inference = openAiInference(net, 'fixture-key', { model: 'gpt-4o-mini' });
  const first = [];
  for await (const event of inference.stream({ ...request, tools: [tool] })) first.push(event);
  expect(first).toContainEqual({ kind: 'tool', toolId: 'book_table', input: { party: 1, time: 'x' } });
  expect(net.pending()).toHaveLength(1); // The text reply is the next turn.
  expect(net.mismatches).toEqual([]);
});
