import { createServer } from 'node:https';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  OpenAiBatchTranscriber,
  OpenAiCachedTtsBridge,
  OpenAiStreamingTts,
  createMonoWav,
  linear16ToMuLaw,
  type OpenAiBatchSttBinding,
  type OpenAiTtsBinding,
  type ProviderUsage,
} from '../src/index.ts';
import { close, listen, localTlsFetch, tlsFixture } from './tls.ts';

const secrets = {
  async resolve() {
    return 'openai-test-key';
  },
};
const ttsBinding = (overrides: Partial<OpenAiTtsBinding> = {}): OpenAiTtsBinding => ({
  workspaceId: 'single-tenant',
  bindingVersion: 'tts-1:v1',
  credentialId: 'credential-1',
  model: 'gpt-4o-mini-tts',
  voice: 'alloy',
  speed: 1,
  requestTimeoutMs: 2_000,
  maxInputCharacters: 4_096,
  maxResponseBytes: 1_024,
  maxOutputChunkBytes: 1,
  ...overrides,
});
const sttBinding = (overrides: Partial<OpenAiBatchSttBinding> = {}): OpenAiBatchSttBinding => ({
  workspaceId: 'single-tenant',
  bindingVersion: 'stt-1:v1',
  credentialId: 'credential-1',
  model: 'gpt-4o-mini-transcribe',
  language: 'en',
  requestTimeoutMs: 2_000,
  maxAudioBytes: 1_024,
  maxResponseBytes: 1_024,
  ...overrides,
});

describe('OpenAI audio adapters', () => {
  it('streams bounded mu-law chunks from documented PCM and bridges full cache audio', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer(await tlsFixture(), async (request, response) => {
      expect(request.url).toBe('/v1/audio/speech');
      expect(request.headers.authorization).toBe('Bearer openai-test-key');
      bodies.push(JSON.parse((await readBody(request)).toString()) as Record<string, unknown>);
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-request-id': 'tts-request',
      });
      const pcm = pcmBytes([0, 0, 0, 1_000, 1_000, 1_000]);
      response.write(pcm.slice(0, 1));
      response.write(pcm.slice(1, 5));
      response.end(pcm.slice(5));
    });
    const port = await listen(server);
    const usages: ProviderUsage[] = [];
    const tts = await OpenAiStreamingTts.create(ttsBinding(), {
      secrets,
      fetch: localTlsFetch,
      endpoint: `https://127.0.0.1:${port}/v1/audio/speech`,
      allowPrivateTestEndpoint: true,
      usage: (usage) => usages.push(usage),
    });
    const chunks = await collect(
      tts.synthesize({
        sessionId: 'session-1',
        text: 'Hi',
        codec: 'audio/x-mulaw',
        sampleRate: 8_000,
        voice: 'alloy',
        signal: new AbortController().signal,
      }),
    );
    expect(chunks.every((chunk) => chunk.byteLength <= 1)).toBe(true);
    expect(Buffer.concat(chunks.map(Buffer.from))).toEqual(
      Buffer.from([linear16ToMuLaw(0), linear16ToMuLaw(1_000)]),
    );
    expect(bodies[0]).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'Hi',
      response_format: 'pcm',
      speed: 1,
    });
    expect(usages[0]).toMatchObject({ quantity: '2', unit: 'characters', state: 'estimated' });

    const cached = new OpenAiCachedTtsBridge(tts);
    const result = await cached.synthesize(
      {
        workspaceId: 'single-tenant',
        provider: 'openai',
        bindingVersion: 'tts-1:v1',
        model: 'gpt-4o-mini-tts',
        voice: 'alloy',
        locale: 'en-IN',
        codec: 'audio/x-mulaw',
        sampleRate: 8_000,
        pronunciation: 'v1',
        prosodyRevision: 'v1',
        optionsRevision: 'v1',
        text: 'Hi',
      },
      { signal: new AbortController().signal },
    );
    expect(result.audio).toEqual(Uint8Array.from([linear16ToMuLaw(0), linear16ToMuLaw(1_000)]));
    expect(result.usage).toEqual({
      provider: 'openai',
      requestId: 'tts-request',
      quantity: '2',
      unit: 'characters',
      state: 'estimated',
    });
    await close(server);
  });

  it('uses multipart batch transcription and keeps omitted usage missing, not zero', async () => {
    let multipart: Uint8Array = new Uint8Array();
    const server = createServer(await tlsFixture(), async (request, response) => {
      expect(request.url).toBe('/v1/audio/transcriptions');
      expect(request.headers.authorization).toBe('Bearer openai-test-key');
      expect(request.headers['content-type']).toContain('multipart/form-data; boundary=');
      multipart = await readBody(request);
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'stt-request',
      });
      response.end(JSON.stringify({ text: 'hello batch', duration: 0.02 }));
    });
    const port = await listen(server);
    const usages: ProviderUsage[] = [];
    const transcriber = await OpenAiBatchTranscriber.create(sttBinding(), {
      secrets,
      fetch: localTlsFetch,
      endpoint: `https://127.0.0.1:${port}/v1/audio/transcriptions`,
      allowPrivateTestEndpoint: true,
      usage: (usage) => usages.push(usage),
    });
    const result = await transcriber.transcribe({
      audio: Uint8Array.from([0xff, 0x7f]),
      codec: 'audio/x-mulaw',
      sampleRate: 8_000,
      signal: new AbortController().signal,
    });
    expect(Buffer.from(multipart).includes(Buffer.from('RIFF'))).toBe(true);
    expect(Buffer.from(multipart).includes(Buffer.from('gpt-4o-mini-transcribe'))).toBe(true);
    expect(result).toMatchObject({
      text: 'hello batch',
      durationSeconds: 0.02,
      requestId: 'stt-request',
    });
    expect(result.usage).toMatchObject({
      state: 'unavailable',
      missing: 'provider-omitted',
      unit: 'tokens',
    });
    expect(result.usage).not.toHaveProperty('quantity');
    expect(usages).toEqual([result.usage]);
    await close(server);
  });

  it('enforces response bounds, cancellation deadlines, and malformed provider responses', async () => {
    let mode: 'oversized' | 'hanging' | 'provider-error' | 'malformed' = 'oversized';
    let hanging: ServerResponse | undefined;
    const server = createServer(await tlsFixture(), async (request, response) => {
      await readBody(request);
      if (mode === 'oversized') {
        response.writeHead(200);
        return response.end(pcmBytes([0, 1, 2, 3, 4, 5]));
      }
      if (mode === 'hanging') {
        hanging = response;
        response.writeHead(200);
        return response.write(Buffer.from([0]));
      }
      if (mode === 'provider-error') {
        response.writeHead(401, { 'content-type': 'application/json' });
        return response.end(JSON.stringify({ error: 'openai-test-key must never escape' }));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{bad-json');
    });
    const port = await listen(server);
    const tts = await OpenAiStreamingTts.create(ttsBinding({ maxResponseBytes: 8 }), {
      secrets,
      fetch: localTlsFetch,
      endpoint: `https://127.0.0.1:${port}/v1/audio/speech`,
      allowPrivateTestEndpoint: true,
    });
    await expect(
      collect(
        tts.synthesize({
          sessionId: 'session-2',
          text: 'bound',
          codec: 'audio/x-mulaw',
          sampleRate: 8_000,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toThrow('byte limit');

    mode = 'hanging';
    const controller = new AbortController();
    const pending = collect(
      tts.synthesize({
        sessionId: 'session-3',
        text: 'cancel',
        codec: 'audio/x-mulaw',
        sampleRate: 8_000,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(new DOMException('call ended', 'AbortError')), 20);
    await expect(pending).rejects.toThrow('call ended');
    hanging?.destroy();

    mode = 'provider-error';
    const providerFailure = await collect(
      tts.synthesize({
        sessionId: 'session-4',
        text: 'error',
        codec: 'audio/x-mulaw',
        sampleRate: 8_000,
        signal: new AbortController().signal,
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(providerFailure).toMatchObject({ message: 'Provider request failed with HTTP 401' });
    expect(String(providerFailure)).not.toContain('openai-test-key');

    mode = 'malformed';
    const transcriber = await OpenAiBatchTranscriber.create(sttBinding(), {
      secrets,
      fetch: localTlsFetch,
      endpoint: `https://127.0.0.1:${port}/v1/audio/transcriptions`,
      allowPrivateTestEndpoint: true,
    });
    await expect(
      transcriber.transcribe({
        audio: Uint8Array.from([0xff]),
        codec: 'audio/x-mulaw',
        sampleRate: 8_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('malformed JSON');
    server.closeAllConnections();
    await close(server);
  });

  it('writes correct mono WAV headers for PCM and mu-law', () => {
    const mulaw = createMonoWav(Uint8Array.from([0xff, 0x7f]), 'audio/x-mulaw', 8_000);
    const pcm = createMonoWav(pcmBytes([1, -1]), 'audio/pcm', 24_000);
    expect(new TextDecoder().decode(mulaw.slice(0, 4))).toBe('RIFF');
    expect(new DataView(mulaw.buffer).getUint16(20, true)).toBe(7);
    expect(new DataView(mulaw.buffer).getUint32(24, true)).toBe(8_000);
    expect(new TextDecoder().decode(mulaw.slice(38, 42))).toBe('fact');
    expect(new TextDecoder().decode(mulaw.slice(50, 54))).toBe('data');
    expect(new DataView(pcm.buffer).getUint16(20, true)).toBe(1);
    expect(new DataView(pcm.buffer).getUint16(34, true)).toBe(16);
  });
});

async function readBody(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function pcmBytes(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}
