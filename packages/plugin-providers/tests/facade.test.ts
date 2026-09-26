import { expect, it } from 'vitest';
import { createFixtureNet } from '../../plugin-kit/src/fixture-net.ts';
import {
  MULAW_8K,
  type Inference,
  type StreamingStt,
  type StreamingTts,
  type ToolDefinition,
} from '@winsendotai/ovo-contracts';
import type { PluginDefinition } from '@winsendotai/ovo-runtime';
import type { NormalizedTts } from '../../plugin-speech-cache/src/types.ts';
import { openAiGenerateTemplate } from '../../plugin-llm-openai/src/testing.ts';
import {
  createDeepgramSttPlugin,
  createOpenAiBatchSttPlugin,
  createOpenAiInferenceProviderPlugin,
  createOpenAiTtsPlugin,
  deepgramBindingFromRecord,
  openAiInferenceBindingFromRecord,
  type DeepgramBinding,
  type OpenAiInferenceBinding,
  type OpenAiTtsBinding,
} from '../src/index.ts';

const base = {
  workspaceId: 'workspace',
  bindingVersion: 'binding:v1',
  credentialId: 'credential',
  model: 'nova-3',
};
const deepgram: DeepgramBinding = {
  ...base,
  endpointingMs: 300,
  connectAttempts: 2,
  connectTimeoutMs: 5000,
  finishTimeoutMs: 3000,
  maxSessionMs: 10000,
  keepAliveMs: 4000,
  maxInputChunkBytes: 16000,
  maxBufferedBytes: 260000,
  maxMessageBytes: 65000,
};
const ttsBinding: OpenAiTtsBinding = {
  ...base,
  model: 'tts-1',
  voice: 'alloy',
  speed: 1,
  requestTimeoutMs: 30000,
  maxInputCharacters: 4096,
  maxResponseBytes: 8000000,
  maxOutputChunkBytes: 3200,
};

function ttsFixture() {
  const audio = new Uint8Array(4800);
  for (let i = 0; i < audio.length; i += 2) {
    audio[i] = i & 255;
    audio[i + 1] = (i >> 8) & 255;
  }
  return createFixtureNet([
    {
      host: 'api.openai.com',
      source: 'https://platform.openai.com/docs/api-reference/audio/createSpeech',
      retrieved: '2026-09-25',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: 'https://api.openai.com/v1/audio/speech',
          headers: { authorization: 'Bearer fixture-key' },
          body: 'json',
          where: { model: 'tts-1', voice: 'alloy', response_format: 'pcm' },
          reply: {
            status: 200,
            headers: { 'x-request-id': 'tts-facade' },
            chunks: [{ base64: Buffer.from(audio).toString('base64') }],
          },
        },
      ],
    },
  ]);
}

async function legacyTtsServices(
  net: ReturnType<typeof ttsFixture>,
  binding: OpenAiTtsBinding = ttsBinding,
) {
  const services = new Map<string, unknown>();
  const ctx = {
    get: (key: string) =>
      key === 'ovo.secret-resolver' ? { resolve: async () => 'fixture-key' } : undefined,
    provide: (key: string, value: unknown) => {
      services.set(key, value);
      return () => undefined;
    },
  } as unknown as Parameters<PluginDefinition['apply']>[0];
  await createOpenAiTtsPlugin(binding, { net }).apply(ctx, {});
  return services;
}

const llmBinding: OpenAiInferenceBinding = { ...base, model: 'gpt-4o-mini', api: 'responses' };
const wireTool: ToolDefinition = {
  id: 'book_slot',
  description: 'Book a slot',
  connector: 'native',
  effect: 'write',
  confirmation: true,
  timeoutMs: 1000,
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    additionalProperties: false,
  },
};
function llmFixture() {
  return createFixtureNet(
    openAiGenerateTemplate({
      format: MULAW_8K,
      language: 'en',
      sessionId: 'legacy-llm',
      turns: [{ atMs: 0, say: 'book' }],
      tools: [{ id: wireTool.id, inputSchema: wireTool.inputSchema, effect: 'write' }],
    }),
  );
}
function legacyLlmContext() {
  const services = new Map<string, unknown>();
  const ctx = {
    get: (key: string) =>
      key === 'ovo.secret-resolver' ? { resolve: async () => 'fixture-key' } : undefined,
    provide: (key: string, value: unknown) => {
      services.set(key, value);
      return () => undefined;
    },
  } as unknown as Parameters<PluginDefinition['apply']>[0];
  return { ctx, services };
}

it('delegates the three legacy factory names to the same-id v2 packages', () => {
  const llm: OpenAiInferenceBinding = { ...base, model: 'gpt-4o-mini', api: 'responses' };
  expect(createDeepgramSttPlugin(deepgram).manifest.id).toBe(
    '@winsendotai/ovo-provider-deepgram-stt',
  );
  expect(createOpenAiTtsPlugin(ttsBinding).manifest.id).toBe(
    '@winsendotai/ovo-provider-openai-tts',
  );
  expect(createOpenAiInferenceProviderPlugin(llm).manifest.id).toBe(
    '@winsendotai/ovo-provider-openai-inference',
  );
});

it('serves the legacy streaming port in mu-law through the host format adapter', async () => {
  const net = ttsFixture();
  const services = await legacyTtsServices(net);
  const tts = services.get('ovo.tts-streaming') as StreamingTts;
  const chunks: Uint8Array[] = [];
  for await (const chunk of tts.synthesize({
    sessionId: 'legacy-tts',
    text: 'Hello',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    signal: new AbortController().signal,
  }))
    chunks.push(chunk);
  expect(Buffer.concat(chunks).byteLength).toBeGreaterThan(0);
  net.assertComplete();
});

it('keeps PCM16 legacy streaming chunks aligned when the configured byte cap is odd', async () => {
  const net = ttsFixture();
  const services = await legacyTtsServices(net, { ...ttsBinding, maxOutputChunkBytes: 3 });
  const tts = services.get('ovo.tts-streaming') as StreamingTts;
  const chunks: Uint8Array[] = [];
  // The v1 TS contract names mu-law only; old JS callers also pass PCM at runtime.
  const pcmRequest = {
    sessionId: 'pcm-legacy',
    text: 'Hello',
    codec: 'audio/pcm',
    sampleRate: 8000,
    signal: new AbortController().signal,
  } as unknown as Parameters<StreamingTts['synthesize']>[0];
  for await (const chunk of tts.synthesize(pcmRequest)) chunks.push(chunk);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((chunk) => chunk.byteLength % 2 === 0)).toBe(true);
  net.assertComplete();
});

it('keeps legacy LLM instructions and the single combined usage callback through FixtureNet', async () => {
  const net = llmFixture();
  const { ctx, services } = legacyLlmContext();
  const events: unknown[] = [];
  await createOpenAiInferenceProviderPlugin(llmBinding, {
    net,
    onInferenceUsage: (evidence) => {
      events.push(evidence);
    },
  }).apply(ctx, { instructions: 'Special legacy instructions' });
  const inference = services.get('ovo.inference') as Inference;
  await inference.generate({
    input: 'book',
    context: 'Reserve a table.',
    uncertainty: 'unknown',
    tools: [wireTool],
    results: [],
    signal: new AbortController().signal,
  });
  const sent = String(net.log.find((entry) => entry.kind === 'http')?.data);
  expect(events).toHaveLength(1);
  expect(events).toMatchObject([
    {
      requestId: 'llm-fixture-1',
      modelId: 'gpt-4o-mini',
      usage: { inputTokens: 12, outputTokens: 8 },
    },
  ]);
  expect(sent).toContain('Special legacy instructions');
  expect(net.mismatches).toEqual([]);
});

it('fails closed on the legacy chat binding before a provider call', async () => {
  const net = createFixtureNet([]);
  const { ctx } = legacyLlmContext();
  await expect(
    createOpenAiInferenceProviderPlugin({ ...llmBinding, api: 'chat' }, { net }).apply(ctx, {}),
  ).rejects.toThrow('chat');
  expect(net.log).toHaveLength(0);
});

it('serves the legacy cached port with a Promise of bounded audio and usage', async () => {
  const net = ttsFixture();
  const services = await legacyTtsServices(net);
  const tts = services.get('ovo.tts') as NormalizedTts;
  const result = await tts.synthesize(
    {
      workspaceId: 'workspace',
      provider: 'openai',
      bindingVersion: 'binding:v1',
      model: 'tts-1',
      voice: 'alloy',
      locale: 'en',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      pronunciation: '',
      prosodyRevision: '',
      optionsRevision: '',
      text: 'Hello',
    },
    { signal: new AbortController().signal },
  );
  expect(result.audio).toBeInstanceOf(Uint8Array);
  expect(result.audio.byteLength).toBeGreaterThan(0);
  expect(result.usage).toMatchObject({
    provider: 'openai',
    unit: 'characters',
    quantity: '5',
    requestId: 'tts-facade',
  });
  net.assertComplete();
});

it('keeps cached binding identity and response bounds on the legacy façade', async () => {
  const net = ttsFixture();
  const services = await legacyTtsServices(net, { ...ttsBinding, maxResponseBytes: 16 });
  const tts = services.get('ovo.tts') as NormalizedTts;
  const request = {
    workspaceId: 'workspace',
    provider: 'openai',
    bindingVersion: 'binding:v1',
    model: 'tts-1',
    voice: 'alloy',
    locale: 'en',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    pronunciation: '',
    prosodyRevision: '',
    optionsRevision: '',
    text: 'Hello',
  };
  const options = { signal: new AbortController().signal };
  await expect(tts.synthesize({ ...request, model: 'other' }, options)).rejects.toThrow(
    'immutable provider binding',
  );
  await expect(tts.synthesize({ ...request, codec: 'audio/unsupported' }, options)).rejects.toThrow(
    'Unsupported TTS codec',
  );
  expect(net.log).toHaveLength(0);
  await expect(tts.synthesize(request, options)).rejects.toThrow('configured byte limit');
  net.assertComplete();
});

it('routes the unchanged legacy STT factory through the host network port and v2 Metadata meter', async () => {
  const net = createFixtureNet([
    {
      host: 'api.deepgram.com',
      source: 'https://developers.deepgram.com/reference/speech-to-text/listen-streaming',
      retrieved: '2026-09-25',
      steps: [
        { expect: 'ws-open', url: /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/ },
        { expect: 'ws-send', match: 'binary' },
        { expect: 'ws-send', match: 'json', where: { type: 'CloseStream' } },
        { send: JSON.stringify({ type: 'Metadata', duration: 1.2, request_id: 'legacy-facade' }) },
      ],
    },
  ]);
  const services = new Map<string, unknown>();
  const meters: unknown[] = [];
  const plugin = createDeepgramSttPlugin(deepgram, { net, usage: (meter) => meters.push(meter) });
  const ctx = {
    get: (key: string) =>
      key === 'ovo.secret-resolver' ? { resolve: async () => 'fixture-key' } : undefined,
    provide: (key: string, value: unknown) => {
      services.set(key, value);
      return () => undefined;
    },
  } as unknown as Parameters<PluginDefinition['apply']>[0];
  await plugin.apply(ctx, {});
  const stt = services.get('ovo.stt') as StreamingStt;
  const stream = await stt.start({
    sessionId: 'legacy-facade',
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    language: 'en',
    signal: new AbortController().signal,
    onTranscript: () => undefined,
  });
  await stream.write(new Uint8Array(800));
  await stream.finish();
  expect(meters).toMatchObject([
    { state: 'reconciled', quantity: '1.2', requestId: 'legacy-facade' },
  ]);
  net.assertComplete();
});

it('keeps strict stored binding parsing and separates unregistered batch STT', () => {
  const record = {
    id: 'binding',
    workspaceId: 'workspace',
    provider: 'deepgram',
    credentialId: 'credential',
    config: { model: 'nova-3' },
    updatedAt: 'v1',
  };
  expect(deepgramBindingFromRecord(record)).toMatchObject({
    model: 'nova-3',
    bindingVersion: 'binding:v1',
    endpointingMs: 300,
  });
  expect(() =>
    deepgramBindingFromRecord({ ...record, config: { model: 'nova-3', apiKey: 'forbidden' } }),
  ).toThrow('Unknown provider binding fields');
  expect(
    openAiInferenceBindingFromRecord({
      ...record,
      provider: 'openai',
      config: { model: 'gpt-4o-mini', api: 'chat' },
    }),
  ).toMatchObject({ api: 'chat' });
  const batch = createOpenAiBatchSttPlugin({
    ...base,
    model: 'gpt-4o-mini-transcribe',
    requestTimeoutMs: 1000,
    maxAudioBytes: 1024,
    maxResponseBytes: 1024,
  });
  expect(batch.manifest.provides).toEqual(['ovo.stt-batch']);
  expect(batch.manifest.provides).not.toContain('ovo.stt');
});
