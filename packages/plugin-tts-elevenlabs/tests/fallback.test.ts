import {
  MULAW_8K,
  PCM16_16K,
  type NetPort,
  type UsageMeter,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { ElevenLabsTts } from '../src/tts.ts';
import { socketOpen } from '../src/testing.ts';
import { drain, httpScript, sent, streamStep, ttsInput, wsScript } from './support.ts';

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');

/** A socket the network refuses (error then close 1006), or one that never finishes connecting. */
function refusedSocket(mode: 'refused' | 'silent'): WebSocketLike {
  let state: 0 | 3 = 0;
  const listeners: Record<string, ((...args: never[]) => void)[]> = {};
  const emit = (event: string, ...args: unknown[]) => {
    for (const fn of listeners[event] ?? []) (fn as (...values: unknown[]) => void)(...args);
  };
  if (mode === 'refused')
    queueMicrotask(() => {
      state = 3;
      emit('error', new Error('handshake failed'));
      emit('close', 1006, '');
    });
  return {
    get readyState() {
      return state;
    },
    send() {
      throw new Error('not open');
    },
    close() {
      state = 3;
    },
    on(event: string, fn: (...args: never[]) => void) {
      (listeners[event] ??= []).push(fn);
      return () => undefined;
    },
  } as WebSocketLike;
}

function netWith(http: ReturnType<typeof createFixtureNet>, socket: () => WebSocketLike) {
  const opened: string[] = [];
  const net: NetPort = {
    fetch: (url, init) => http.fetch(url, init),
    websocket(url) {
      opened.push(url);
      return socket();
    },
  };
  return { net, opened };
}

describe('ElevenLabs HTTP stream fallback', () => {
  it('speaks over HTTP when the socket is refused, then skips the socket for 30 s', async () => {
    const clock = new FakeClock();
    const http = createFixtureNet(
      [
        httpScript([
          streamStep({ status: 200, chunks: [b64([1, 2])] }),
          streamStep({ status: 200, chunks: [b64([3])] }),
        ]),
      ],
      { clock },
    );
    const { net, opened } = netWith(http, () => refusedSocket('refused'));
    const tts = new ElevenLabsTts(net, 'fixture-key', {}, clock);
    const usage: UsageMeter[] = [];
    const first = await tts.open(ttsInput(usage));
    first.push('Hello ');
    first.push('there.');
    first.flush();
    expect(await drain(first.audio)).toEqual([1, 2]);
    await first.close();
    expect(JSON.parse(String(http.log[0]!.data))).toMatchObject({ text: 'Hello there.' });
    clock.advance(29_000);
    expect(await drain(tts.synthesize({ ...ttsInput(usage), text: 'Again.' }))).toEqual([3]);
    expect(opened).toHaveLength(1);
    expect(usage).toMatchObject([
      { quantity: '12', state: 'estimated', requestId: 'elevenlabs:call-1:1' },
      { quantity: '6', state: 'estimated', requestId: 'elevenlabs:call-1:2' },
    ]);
    clock.advance(2_000);
    await tts.open(ttsInput()).then((context) => context.close());
    expect(opened).toHaveLength(2);
    http.assertComplete();
  });

  it('falls back after the connect timeout when the handshake never completes', async () => {
    const clock = new FakeClock();
    const http = createFixtureNet([httpScript([streamStep({ status: 200, chunks: [b64([5])] })])], {
      clock,
    });
    const { net } = netWith(http, () => refusedSocket('silent'));
    const tts = new ElevenLabsTts(net, 'fixture-key', { connectTimeoutMs: 1500 }, clock);
    const pending = tts.open(ttsInput());
    await clock.advanceAsync(1499);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await clock.advanceAsync(1);
    const context = await pending;
    context.push('Late.');
    context.flush();
    expect(await drain(context.audio)).toEqual([5]);
    await context.close();
    http.assertComplete();
  });

  it('surfaces the socket failure when httpFallback is off', async () => {
    const { net } = netWith(createFixtureNet([]), () => refusedSocket('refused'));
    const tts = new ElevenLabsTts(net, 'fixture-key', { httpFallback: false });
    await expect(tts.open(ttsInput())).rejects.toMatchObject({
      name: 'ElevenLabsTtsError',
      message: 'ElevenLabs TTS socket error: handshake failed',
      retryable: true,
    });
  });

  it('retries a synthesis over HTTP when the socket drops before any audio', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'Your EMI is due.' }),
        sent('ovo-1', { text: '', flush: true }),
        sent('ovo-1', { close_context: true }),
        { close: { code: 1011, reason: 'internal error' } },
      ]),
      httpScript([streamStep({ status: 200, chunks: [b64([8, 9])] })]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key');
    expect(await drain(tts.synthesize({ ...ttsInput(usage), text: 'Your EMI is due.' }))).toEqual([
      8, 9,
    ]);
    // One synthesis, one meter: the dropped socket's estimate is replaced by the retry's.
    expect(usage.map((meter) => meter.requestId)).toEqual(['elevenlabs:call-1:2']);
    net.assertComplete();
  });

  it('does not retry a refused socket (policy close 1008)', async () => {
    const net = createFixtureNet([
      wsScript([
        socketOpen(MULAW_8K),
        sent('ovo-1', { text: 'Hi.' }),
        sent('ovo-1', { text: '', flush: true }),
        sent('ovo-1', { close_context: true }),
        { close: { code: 1008, reason: 'invalid api key' } },
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key');
    await expect(drain(tts.synthesize({ ...ttsInput(), text: 'Hi.' }))).rejects.toMatchObject({
      status: 1008,
      retryable: false,
    });
    net.assertComplete();
  });
});

describe('ElevenLabs HTTP stream (transport: http)', () => {
  it('sends the documented body and retries 429 before the first byte', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        httpScript([
          streamStep({
            status: 429,
            body: '{"detail":{"status":"too_many_concurrent_requests"}}',
          }),
          streamStep(
            {
              status: 200,
              headers: { 'request-id': 'req-123', 'character-cost': '5' },
              chunks: [b64([7])],
            },
            MULAW_8K,
            {
              text: 'Hello',
              model_id: 'eleven_multilingual_v2',
              voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1, style: 0.1 },
              language_code: 'ta',
              seed: 3,
              apply_text_normalization: 'on',
              pronunciation_dictionary_locators: [{ pronunciation_dictionary_id: 'names' }],
            },
          ),
        ]),
      ],
      { clock },
    );
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(
      net,
      'fixture-key',
      {
        transport: 'http',
        model: 'eleven_multilingual_v2',
        stability: 0.4,
        style: 0.1,
        languageCode: 'ta',
        seed: 3,
        applyTextNormalization: 'on',
        pronunciationDictionaries: [{ id: 'names' }],
      },
      clock,
    );
    const done = drain(tts.synthesize({ ...ttsInput(usage), text: 'Hello' }));
    await clock.advanceAsync(250);
    expect(await done).toEqual([7]);
    expect(usage).toEqual([
      expect.objectContaining({ quantity: '5', state: 'reconciled', requestId: 'req-123' }),
    ]);
    net.assertComplete();
  });

  it('retries 409 (voice warming up) and 503 twice, then gives up on a third failure', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        httpScript([
          streamStep({ status: 409, body: '{"detail":{"status":"voice_not_ready"}}' }),
          streamStep({ status: 503, body: 'unavailable' }),
          streamStep({ status: 200, chunks: [b64([9])] }),
          streamStep({ status: 409, body: '{}' }),
          streamStep({ status: 500, body: '{}' }),
          streamStep({ status: 502, body: '{}' }),
        ]),
      ],
      { clock },
    );
    const tts = new ElevenLabsTts(net, 'fixture-key', { transport: 'http' }, clock);
    const first = drain(tts.synthesize({ ...ttsInput(), text: 'One' }));
    await clock.advanceAsync(250);
    await clock.advanceAsync(500);
    expect(await first).toEqual([9]);
    const second = drain(tts.synthesize({ ...ttsInput(), text: 'Two' }));
    const failed = expect(second).rejects.toMatchObject({ status: 502, retryable: true });
    await clock.advanceAsync(250);
    await clock.advanceAsync(500);
    await failed;
    net.assertComplete();
  });

  it('reads x-character-count when character-cost is absent, and estimates without either', async () => {
    const net = createFixtureNet([
      httpScript([
        streamStep({ status: 200, headers: { 'x-character-count': '4' }, chunks: [b64([7])] }),
        streamStep({ status: 200, headers: { 'character-cost': 'n/a' }, chunks: [b64([8])] }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key', { transport: 'http' });
    expect(await drain(tts.synthesize({ ...ttsInput(usage), text: 'Hiya' }))).toEqual([7]);
    expect(await drain(tts.synthesize({ ...ttsInput(usage), text: 'Hello' }))).toEqual([8]);
    expect(usage).toEqual([
      expect.objectContaining({ quantity: '4', state: 'reconciled' }),
      expect.objectContaining({ quantity: '5', state: 'estimated' }),
    ]);
    expect(new Set(usage.map((meter) => meter.requestId)).size).toBe(2);
    net.assertComplete();
  });

  it('does not retry a 401 and keeps the provider status code', async () => {
    const net = createFixtureNet([
      httpScript([
        streamStep({
          status: 401,
          body: '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}',
        }),
      ]),
    ]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key', { transport: 'http' });
    await expect(drain(tts.synthesize({ ...ttsInput(usage), text: 'Hi' }))).rejects.toMatchObject({
      message: 'ElevenLabs TTS failed with HTTP 401: invalid_api_key',
      status: 401,
      retryable: false,
    });
    expect(usage).toHaveLength(1);
    net.assertComplete();
  });

  it('re-cuts PCM chunks into whole samples and rejects a trailing half sample', async () => {
    const net = createFixtureNet([
      httpScript([
        streamStep({ status: 200, chunks: [b64([1, 2, 3]), b64([4, 5, 6])] }, PCM16_16K),
        streamStep({ status: 200, chunks: [b64([1, 2, 3])] }, PCM16_16K),
      ]),
    ]);
    const tts = new ElevenLabsTts(net, 'fixture-key', { transport: 'http' });
    const chunks: number[][] = [];
    for await (const chunk of tts.synthesize({ ...ttsInput(), text: 'A', format: PCM16_16K }))
      chunks.push([...chunk]);
    expect(chunks).toEqual([
      [1, 2],
      [3, 4, 5, 6],
    ]);
    await expect(
      drain(tts.synthesize({ ...ttsInput(), text: 'B', format: PCM16_16K })),
    ).rejects.toThrow('incomplete PCM sample');
    net.assertComplete();
  });

  it('never opens a socket and meters a closed-before-flush utterance once at zero', async () => {
    const net = createFixtureNet([]);
    const usage: UsageMeter[] = [];
    const tts = new ElevenLabsTts(net, 'fixture-key', { transport: 'http' });
    const context = await tts.open(ttsInput(usage));
    context.push('never spoken');
    await context.close();
    await context.close();
    expect(await drain(context.audio)).toEqual([]);
    expect(usage).toMatchObject([{ quantity: '0', requestId: 'elevenlabs:call-1:1' }]);
    expect(net.log).toEqual([]);
  });
});
