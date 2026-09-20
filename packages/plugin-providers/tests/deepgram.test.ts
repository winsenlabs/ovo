import { createServer } from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
import { describe, expect, it } from 'vitest';
import { DeepgramStreamingStt, type DeepgramBinding, type ProviderUsage } from '../src/index.ts';
import { close, listen, tlsFixture } from './tls.ts';

const binding = (overrides: Partial<DeepgramBinding> = {}): DeepgramBinding => ({
  workspaceId: 'single-tenant',
  bindingVersion: 'binding-1:version-1',
  credentialId: 'credential-1',
  model: 'nova-3',
  language: 'en-IN',
  endpointingMs: 300,
  utteranceEndMs: 1_000,
  connectAttempts: 2,
  connectTimeoutMs: 1_000,
  finishTimeoutMs: 1_000,
  maxSessionMs: 10_000,
  keepAliveMs: 4_000,
  maxInputChunkBytes: 1_024,
  maxBufferedBytes: 16_384,
  maxMessageBytes: 65_536,
  ...overrides,
});

const secrets = {
  async resolve() {
    return 'deepgram-test-key';
  },
};

describe('Deepgram realtime WebSocket adapter', () => {
  it('uses the real WSS protocol, emits revisions and usage, and never replays audio', async () => {
    const server = createServer(await tlsFixture());
    const wss = new WebSocketServer({ server, path: '/v1/listen' });
    const queries: URLSearchParams[] = [];
    const authorizations: Array<string | undefined> = [];
    let audioFrames = 0;
    wss.on('connection', (socket, request) => {
      queries.push(new URL(request.url!, 'https://localhost').searchParams);
      authorizations.push(request.headers.authorization);
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          audioFrames += 1;
          expect(Buffer.from(data as Buffer)).toEqual(Buffer.alloc(160, 0x7f));
          socket.send(result('hel', false, false, 0.61, 0, 0.2));
          socket.send(result('hello', true, true, 0.94, 0, 0.5));
        } else if (JSON.parse(data.toString()).type === 'CloseStream') {
          socket.send(
            JSON.stringify({ type: 'Metadata', request_id: 'dg-request', duration: 1.25 }),
          );
          socket.close(1000, 'complete');
        }
      });
    });
    const port = await listen(server);
    const usages: ProviderUsage[] = [];
    let attempts = 0;
    const client = await DeepgramStreamingStt.create(binding(), {
      secrets,
      endpoint: `wss://127.0.0.1:${port}/v1/listen`,
      allowPrivateTestEndpoint: true,
      usage: (usage) => usages.push(usage),
      webSocketFactory(url, options) {
        attempts += 1;
        return new WebSocket(attempts === 1 ? 'wss://127.0.0.1:1/v1/listen' : url, {
          ...options,
          rejectUnauthorized: false,
        });
      },
    });
    const revisions: unknown[] = [];
    const controller = new AbortController();
    const stream = await client.start({
      sessionId: 'session-1',
      codec: 'audio/x-mulaw',
      sampleRate: 8_000,
      language: 'en-IN',
      signal: controller.signal,
      onTranscript: (revision) => revisions.push(revision),
    });
    await stream.write(Buffer.alloc(160, 0x7f));
    await stream.finish();

    expect(attempts).toBe(2);
    expect(audioFrames).toBe(1);
    expect(authorizations).toEqual(['Token deepgram-test-key']);
    expect(queries[0]?.get('encoding')).toBe('mulaw');
    expect(queries[0]?.get('sample_rate')).toBe('8000');
    expect(queries[0]?.get('interim_results')).toBe('true');
    expect(queries[0]?.get('vad_events')).toBe('true');
    expect(queries[0]?.get('endpointing')).toBe('300');
    expect(revisions).toEqual([
      {
        revision: 1,
        text: 'hel',
        isFinal: false,
        speechFinal: false,
        speechStarted: true,
        confidence: 0.61,
        startMs: 0,
        durationMs: 200,
      },
      {
        revision: 2,
        text: 'hello',
        isFinal: true,
        speechFinal: true,
        confidence: 0.94,
        startMs: 0,
        durationMs: 500,
      },
    ]);
    expect(usages).toEqual([
      expect.objectContaining({
        requestId: 'dg-request',
        quantity: '1.25',
        unit: 'audio_seconds',
        state: 'reconciled',
      }),
    ]);
    wss.close();
    await close(server);
  });

  it('bounds input and reports omitted usage as unavailable rather than zero on cancellation', async () => {
    const server = createServer(await tlsFixture());
    const wss = new WebSocketServer({ server, path: '/v1/listen' });
    wss.on('connection', (socket) => socket.on('error', () => undefined));
    const port = await listen(server);
    const usages: ProviderUsage[] = [];
    const controller = new AbortController();
    const client = await DeepgramStreamingStt.create(binding({ maxInputChunkBytes: 160 }), {
      secrets,
      endpoint: `wss://127.0.0.1:${port}/v1/listen`,
      allowPrivateTestEndpoint: true,
      usage: (usage) => usages.push(usage),
      webSocketFactory: (url, options) =>
        new WebSocket(url, { ...options, rejectUnauthorized: false }),
    });
    const stream = await client.start({
      sessionId: 'session-2',
      codec: 'audio/x-mulaw',
      sampleRate: 8_000,
      language: 'en-IN',
      signal: controller.signal,
      onTranscript() {},
    });
    await expect(stream.write(new Uint8Array(161))).rejects.toThrow('configured limit');
    controller.abort(new DOMException('call ended', 'AbortError'));
    await expect(stream.write(new Uint8Array(160))).rejects.toThrow('call ended');
    expect(usages).toEqual([
      expect.objectContaining({
        state: 'unavailable',
        missing: 'provider-omitted',
        unit: 'audio_seconds',
      }),
    ]);
    expect(usages[0]).not.toHaveProperty('quantity');
    wss.clients.forEach((socket) => socket.terminate());
    wss.close();
    await close(server);
  });

  it('rejects malformed provider frames', async () => {
    const server = createServer(await tlsFixture());
    const wss = new WebSocketServer({ server, path: '/v1/listen' });
    wss.on('connection', (socket) => setImmediate(() => socket.send('{not-json')));
    const port = await listen(server);
    const client = await DeepgramStreamingStt.create(binding({ connectAttempts: 1 }), {
      secrets,
      endpoint: `wss://127.0.0.1:${port}/v1/listen`,
      allowPrivateTestEndpoint: true,
      webSocketFactory: (url, options) =>
        new WebSocket(url, { ...options, rejectUnauthorized: false }),
    });
    const stream = await client.start({
      sessionId: 'session-3',
      codec: 'audio/x-mulaw',
      sampleRate: 8_000,
      language: 'en-IN',
      signal: new AbortController().signal,
      onTranscript() {},
    });
    await expect(stream.finish()).rejects.toThrow('malformed JSON');
    wss.clients.forEach((socket) => socket.terminate());
    wss.close();
    await close(server);
  });
});

function result(
  text: string,
  isFinal: boolean,
  speechFinal: boolean,
  confidence: number,
  start: number,
  duration: number,
) {
  return JSON.stringify({
    type: 'Results',
    is_final: isFinal,
    speech_final: speechFinal,
    start,
    duration,
    metadata: { request_id: 'dg-request' },
    channel: { alternatives: [{ transcript: text, confidence }] },
  });
}
