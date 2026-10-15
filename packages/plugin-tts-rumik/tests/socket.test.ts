import {
  MULAW_8K,
  type NetPort,
  type UsageMeter,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { WS_URL_REJECTED, RumikTtsError } from '../src/errors.ts';
import { socketUrl } from '../src/mint.ts';
import {
  FIXTURE_BINDING,
  FIXTURE_KEY,
  fixtureAudio,
  generationSteps,
  mintSteps,
  socketOpen,
  synthesisStep,
} from '../src/testing.ts';
import { RumikTts } from '../src/tts.ts';
import { drain, frame, httpScript, recordingLogger, script, settle, ttsInput } from './support.ts';

const TEXT = 'Namaste, main Ira bol rahi hoon.';
const speak = (tts: RumikTts, usage: UsageMeter[] = [], text = TEXT) =>
  drain(tts.synthesize(ttsInput(usage, { text })));

/** The fixture net, recording the options of every socket it opens. */
function spied(net: NetPort) {
  const opened: { url: string; opts?: Parameters<NetPort['websocket']>[1] }[] = [];
  const port: NetPort = {
    fetch: (url, init) => net.fetch(url, init),
    websocket(url, opts) {
      opened.push({ url, ...(opts ? { opts } : {}) });
      return net.websocket(url, opts);
    },
  };
  return { port, opened };
}

/** A socket whose handshake never completes. */
function silentSocket(): WebSocketLike {
  return {
    readyState: 0,
    send() {
      throw new Error('not open');
    },
    close() {},
    on: () => () => undefined,
  };
}

describe('R2: minting the socket', () => {
  it('mints with the model, "init" and audio_format, then connects to ws_url?token= without the key', async () => {
    const net = createFixtureNet([
      script([...mintSteps(MULAW_8K), socketOpen(), ...generationSteps(TEXT, MULAW_8K, 1)]),
    ]);
    const { port, opened } = spied(net);
    const usage: UsageMeter[] = [];
    const tts = new RumikTts(port, FIXTURE_KEY, FIXTURE_BINDING);
    expect(await speak(tts, usage)).toEqual([...fixtureAudio(MULAW_8K, TEXT, 1)]);
    expect(opened.map((socket) => socket.url)).toEqual([
      'wss://silk-api.rumik.ai/ws/tts?token=tok-1',
    ]);
    // The token is the socket's only credential: no header, so the key never rides on it.
    expect(opened[0]!.opts?.headers ?? {}).toEqual({});
    expect(usage).toEqual([
      expect.objectContaining({
        provider: 'rumik',
        operation: 'tts',
        unit: 'characters',
        state: 'estimated',
        requestId: 'rumik:call-1:1',
        quantity: String([...TEXT].length + FIXTURE_BINDING.description.length),
      }),
    ]);
    net.assertComplete();
  });

  it('accepts only wss://silk-api.rumik.ai, and adds the token to the minted path', () => {
    expect(socketUrl('wss://silk-api.rumik.ai/ws/tts', 'a b&c')).toBe(
      'wss://silk-api.rumik.ai/ws/tts?token=a+b%26c',
    );
    expect(socketUrl('wss://silk-api.rumik.ai/v2/tts?region=in', 't')).toBe(
      'wss://silk-api.rumik.ai/v2/tts?region=in&token=t',
    );
    for (const bad of [
      'wss://evil.example/ws/tts',
      'wss://silk-api.rumik.ai.evil.example/ws/tts',
      'ws://silk-api.rumik.ai/ws/tts',
      'https://silk-api.rumik.ai/ws/tts',
      'wss://silk-api.rumik.ai:8443/ws/tts',
      'wss://user:pass@silk-api.rumik.ai/ws/tts',
      'not a url',
    ])
      expect(() => socketUrl(bad, 't'), bad).toThrow(
        expect.objectContaining({ code: WS_URL_REJECTED }),
      );
    expect(() => socketUrl('wss://silk-api.rumik.ai/ws/tts', '')).toThrow(RumikTtsError);
  });

  it('never connects to a refused ws_url: HTTP renders the line, or the error surfaces', async () => {
    const evil = { wsUrl: 'wss://audio.evil.example/ws/tts' };
    const net = createFixtureNet([
      script(mintSteps(MULAW_8K, evil)),
      httpScript([synthesisStep(TEXT, MULAW_8K, fixtureAudio(MULAW_8K, TEXT))]),
    ]);
    const { port, opened } = spied(net);
    expect(await speak(new RumikTts(port, FIXTURE_KEY, FIXTURE_BINDING))).toHaveLength(
      fixtureAudio(MULAW_8K, TEXT).byteLength,
    );
    net.assertComplete();

    const strict = createFixtureNet([script(mintSteps(MULAW_8K, evil))]);
    const spiedStrict = spied(strict);
    const result = await settle(
      new RumikTts(spiedStrict.port, FIXTURE_KEY, {
        ...FIXTURE_BINDING,
        httpFallback: false,
      }).synthesize(ttsInput()),
    );
    expect(result.error).toMatchObject({ code: WS_URL_REJECTED });
    expect([...opened, ...spiedStrict.opened]).toEqual([]);
    strict.assertComplete();
  });

  it('mints again when the token is already stale on arrival', async () => {
    const clock = new FakeClock();
    // expires_in 7 s, less the 5 s margin, counted from the send: stale once the answer takes 2.5 s.
    const net = createFixtureNet(
      [
        script([
          { delayMs: 2500 },
          ...mintSteps(MULAW_8K, { token: 'stale', expiresIn: 7 }),
          ...mintSteps(MULAW_8K, { token: 'fresh' }),
          socketOpen('fresh'),
          ...generationSteps(TEXT, MULAW_8K, 1),
        ]),
      ],
      { clock },
    );
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock);
    const audio = speak(tts);
    await clock.advanceAsync(2500);
    expect(await audio).toHaveLength(fixtureAudio(MULAW_8K, TEXT, 1).byteLength);
    net.assertComplete();
  });

  it('mints a fresh socket after the server closes one', async () => {
    const net = createFixtureNet([
      script([
        ...mintSteps(MULAW_8K),
        socketOpen(),
        ...generationSteps('Pehli line.', MULAW_8K, 1),
        { close: { code: 1001, reason: 'going away' } },
        ...mintSteps(MULAW_8K, { token: 'tok-2' }),
        socketOpen('tok-2'),
        ...generationSteps('Doosri line.', MULAW_8K, 2),
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    expect(await speak(tts, [], 'Pehli line.')).not.toHaveLength(0);
    expect(await speak(tts, [], 'Doosri line.')).not.toHaveLength(0);
    net.assertComplete();
  });

  it('treats {"type":"timeout"} as the end of the socket and mints again for the next line', async () => {
    const logger = recordingLogger();
    const net = createFixtureNet([
      script([
        ...mintSteps(MULAW_8K),
        socketOpen(),
        ...generationSteps('Pehli line.', MULAW_8K, 1),
        frame({ type: 'timeout' }),
        ...mintSteps(MULAW_8K, { token: 'tok-2' }),
        socketOpen('tok-2'),
        ...generationSteps('Doosri line.', MULAW_8K, 2),
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, undefined, logger);
    await speak(tts, [], 'Pehli line.');
    await speak(tts, [], 'Doosri line.');
    expect(logger.lines.map((line) => line.event)).toContain('rumik.tts.socket_timeout');
    expect(net.log.filter((entry) => entry.kind === 'ws-close')[0]).toMatchObject({
      data: '1000 ',
    });
    net.assertComplete();
  });

  it('surfaces a refused key without retrying over HTTP', async () => {
    const net = createFixtureNet([script(mintSteps(MULAW_8K, { status: 401 }))]);
    const usage: UsageMeter[] = [];
    const result = await settle(
      new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING).synthesize(ttsInput(usage)),
    );
    expect(result.error).toMatchObject({ status: 401, retryable: false, code: 'HTTP_401' });
    expect(usage).toEqual([]);
    net.assertComplete();
  });

  it('falls back to HTTP when the mint fails, and skips the socket for 30 s after', async () => {
    const clock = new FakeClock();
    const audio = (text: string, seed: number) => fixtureAudio(MULAW_8K, text, seed);
    const net = createFixtureNet(
      [
        script([
          ...mintSteps(MULAW_8K, { status: 503 }),
          ...mintSteps(MULAW_8K, { token: 'tok-2' }),
          socketOpen('tok-2'),
          ...generationSteps('Teesri.', MULAW_8K, 3),
        ]),
        httpScript([
          synthesisStep('Pehli.', MULAW_8K, audio('Pehli.', 1)),
          synthesisStep('Doosri.', MULAW_8K, audio('Doosri.', 2)),
        ]),
      ],
      { clock },
    );
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock);
    expect(await speak(tts, [], 'Pehli.')).toEqual([...audio('Pehli.', 1)]);
    clock.advance(29_000);
    expect(await speak(tts, [], 'Doosri.')).toEqual([...audio('Doosri.', 2)]);
    clock.advance(1_000);
    expect(await speak(tts, [], 'Teesri.')).toEqual([...audio('Teesri.', 3)]);
    net.assertComplete();
  });

  it('falls back to HTTP when the handshake does not complete within connectTimeoutMs', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      [
        script(mintSteps(MULAW_8K)),
        httpScript([synthesisStep(TEXT, MULAW_8K, fixtureAudio(MULAW_8K, TEXT))]),
      ],
      { clock },
    );
    const port: NetPort = { fetch: (url, init) => net.fetch(url, init), websocket: silentSocket };
    const tts = new RumikTts(
      port,
      FIXTURE_KEY,
      { ...FIXTURE_BINDING, connectTimeoutMs: 1500 },
      clock,
    );
    const audio = speak(tts);
    await clock.advanceAsync(1499);
    expect(net.log.filter((entry) => entry.url?.endsWith('/v1/tts'))).toEqual([]);
    await clock.advanceAsync(1);
    expect(await audio).toHaveLength(fixtureAudio(MULAW_8K, TEXT).byteLength);
    net.assertComplete();
  });

  it('warm() mints and connects once; the first line reuses that socket', async () => {
    const net = createFixtureNet([
      script([...mintSteps(MULAW_8K), socketOpen(), ...generationSteps(TEXT, MULAW_8K, 1)]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    await tts.warm({ format: MULAW_8K });
    expect(net.log.map((entry) => entry.kind)).toEqual(['http', 'ws-open']);
    await speak(tts);
    net.assertComplete();
  });

  it('closes the socket with {"type":"close"} at session end', async () => {
    const net = createFixtureNet([
      script([
        ...mintSteps(MULAW_8K),
        socketOpen(),
        ...generationSteps(TEXT, MULAW_8K, 1),
        { expect: 'ws-send', match: 'json', where: { type: 'close' } },
      ]),
    ]);
    const tts = new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING);
    await speak(tts);
    tts.dispose();
    await Promise.resolve();
    expect(net.log.at(-1)).toMatchObject({ kind: 'ws-close', data: '1000 ' });
    await expect(drain(tts.synthesize(ttsInput()))).rejects.toThrow(/disposed/);
    net.assertComplete();
  });
});
