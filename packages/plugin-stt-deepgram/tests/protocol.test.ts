import { describe, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  type SpeechToText,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { DeepgramStt, listenUrl } from '../src/deepgram.ts';
import { deepgramPlugin } from '../src/index.ts';
import { deepgramTemplate } from '../src/testing.ts';

const source = 'https://developers.deepgram.com/reference/speech-to-text/listen-streaming';
const result = (text: string, final: boolean, speechFinal: boolean, fromFinalize = false) =>
  JSON.stringify({
    type: 'Results',
    duration: 99,
    start: 0,
    is_final: final,
    speech_final: speechFinal,
    from_finalize: fromFinalize,
    channel: { alternatives: [{ transcript: text, words: [] }] },
  });

function session(steps: Parameters<typeof createFixtureNet>[0][number]['steps']) {
  const net = createFixtureNet([
    {
      host: 'api.deepgram.com',
      source,
      retrieved: '2026-09-25',
      steps: [
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/,
          headers: { authorization: 'Token fixture-key' },
        },
        ...steps,
      ],
    },
  ]);
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const stt = new DeepgramStt(net, 'fixture-key');
  const start = () =>
    stt.start({
      sessionId: 's1',
      format: MULAW_8K,
      language: 'en',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onUsage: (meter) => usage.push(meter),
    });
  return { net, events, usage, start };
}

describe('Deepgram documented wire protocol', () => {
  it('rejects malformed provider JSON and emits one estimated meter', async () => {
    const run = session([{ expect: 'ws-send', match: 'binary' }, { send: '{bad-json' }]);
    const stream = await run.start();
    await stream.write(new Uint8Array(800));
    await expect(stream.finish()).rejects.toThrow('malformed JSON');
    expect(run.usage).toMatchObject([{ state: 'estimated' }]);
    expect(run.usage).toHaveLength(1);
    run.net.assertComplete();
  });

  it('sends KeepAlive on the injected clock every five seconds until Metadata', async () => {
    const clock = new FakeClock(100);
    const net = createFixtureNet([
      {
        host: 'api.deepgram.com',
        source,
        retrieved: '2026-09-25',
        steps: [
          { expect: 'ws-open', url: /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/ },
          { expect: 'ws-send', match: 'json', where: { type: 'KeepAlive' } },
          { expect: 'ws-send', match: 'json', where: { type: 'KeepAlive' } },
          { expect: 'ws-send', match: 'json', where: { type: 'CloseStream' } },
          { send: JSON.stringify({ type: 'Metadata', duration: 0, request_id: 'keepalive-id' }) },
        ],
      },
    ]);
    const usage: UsageMeter[] = [];
    const stt = new DeepgramStt(net, 'fixture-key', { model: 'nova-3' }, clock);
    const stream = await stt.start({
      sessionId: 'keepalive',
      format: MULAW_8K,
      language: 'en',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onUsage: (meter) => usage.push(meter),
    });
    clock.advance(4999);
    expect(net.log.filter((entry) => entry.kind === 'ws-out')).toHaveLength(0);
    clock.advance(5001);
    expect(net.log.filter((entry) => entry.kind === 'ws-out')).toHaveLength(2);
    await stream.finish();
    expect(usage).toMatchObject([{ requestId: 'keepalive-id', elapsedMs: 10000 }]);
    expect(clock.pendingTimers).toBe(0);
    net.assertComplete();
  });
  it('uses Metadata.duration alone, and translates all turn signals', async () => {
    const run = session([
      { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
      { send: JSON.stringify({ type: 'SpeechStarted', timestamp: 0.25 }) },
      { send: result('hello', false, false) },
      { send: result('hello', true, true) },
      { send: JSON.stringify({ type: 'UtteranceEnd', last_word_end: 0.8 }) },
      { expect: 'ws-send', match: 'json', where: { type: 'CloseStream' } },
      { send: JSON.stringify({ type: 'Metadata', duration: 1.2, request_id: 'dg-real-id' }) },
      { close: { code: 1000 } },
    ]);
    const stream = await run.start();
    await stream.write(new Uint8Array(800));
    await stream.finish();
    expect(run.events.map((event) => event.type)).toEqual([
      'speech-start',
      'transcript',
      'transcript',
      'end-of-turn',
      'utterance-end',
    ]);
    expect(run.usage).toMatchObject([
      { state: 'reconciled', quantity: '1.2', requestId: 'dg-real-id' },
    ]);
    run.net.assertComplete();
  });

  it('Finalize keeps the socket writable and abrupt 1011 emits estimated usage once', async () => {
    const run = session([
      { expect: 'ws-send', match: 'binary' },
      { expect: 'ws-send', match: 'json', where: { type: 'Finalize' } },
      { send: result('hello', true, true, true) },
      { expect: 'ws-send', match: 'binary' },
      { close: { code: 1011, reason: 'server failed' } },
    ]);
    const stream = await run.start();
    await stream.write(new Uint8Array(4000));
    await stream.forceEndpoint?.();
    await stream.write(new Uint8Array(4000));
    await expect(stream.finish()).rejects.toThrow('before Metadata');
    expect(run.usage).toMatchObject([
      { state: 'estimated', quantity: '1', requestId: 'deepgram:s1:1' },
    ]);
    expect(run.events).toContainEqual({ type: 'end-of-turn' });
    run.net.assertComplete();
  });

  it('builds format-specific queries and repeats keyterms', () => {
    const url = new URL(
      listenUrl({ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 }, 'hi', {
        model: 'nova-3',
        keyterms: ['restaurant', 'book a table'],
      }),
    );
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.getAll('keyterm')).toEqual(['restaurant', 'book a table']);
  });

  it('renders a separate interim/final/end sequence for every caller say', async () => {
    const net = createFixtureNet(
      deepgramTemplate({
        format: MULAW_8K,
        language: 'en',
        sessionId: 'two-says',
        turns: [
          { atMs: 0, say: 'hello' },
          { atMs: 1500, say: 'world' },
        ],
      }),
    );
    const events: SttEvent[] = [];
    const stt = new DeepgramStt(net, 'fixture-key');
    const stream = await stt.start({
      sessionId: 'two-says',
      format: MULAW_8K,
      language: 'en',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      onUsage: () => undefined,
    });
    await stream.write(new Uint8Array(800));
    await stream.finish();
    const finals = events.flatMap((event) =>
      event.type === 'transcript' && event.segment.stability === 'final'
        ? [event.segment.text]
        : [],
    );
    expect(finals).toEqual(['hello', 'world']);
    expect(events.filter((event) => event.type === 'speech-start')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'end-of-turn')).toHaveLength(2);
    net.assertComplete();
  });

  it('settles a finish aborted after CloseStream, closes, and emits one estimate', async () => {
    const run = session([
      { expect: 'ws-send', match: 'binary' },
      { expect: 'ws-send', match: 'json', where: { type: 'CloseStream' } },
    ]);
    const stream = await run.start();
    await stream.write(new Uint8Array(4000));
    const controller = new AbortController();
    const finishing = stream.finish(controller.signal);
    controller.abort(new DOMException('finish abandoned', 'AbortError'));
    await expect(finishing).rejects.toThrow('finish abandoned');
    expect(run.usage).toMatchObject([{ state: 'estimated', quantity: '0.5' }]);
    expect(run.net.log.filter((entry) => entry.kind === 'ws-close')).toHaveLength(1);
    run.net.assertComplete();
  });

  it('does not send CloseStream when finish receives an already-aborted signal', async () => {
    const run = session([{ expect: 'ws-send', match: 'binary' }]);
    const stream = await run.start();
    await stream.write(new Uint8Array(4000));
    const controller = new AbortController();
    controller.abort(new DOMException('already stopped', 'AbortError'));
    await expect(stream.finish(controller.signal)).rejects.toThrow('already stopped');
    expect(
      run.net.log.filter((entry) => entry.kind === 'ws-out').map((entry) => entry.data),
    ).toEqual([new Uint8Array(4000)]);
    expect(run.usage).toMatchObject([{ state: 'estimated', quantity: '0.5' }]);
    run.net.assertComplete();
  });

  it('settles and meters a failed CloseStream send instead of leaking the socket', async () => {
    const run = session([{ expect: 'ws-send', match: 'binary' }]);
    const stream = await run.start();
    await stream.write(new Uint8Array(4000));
    await expect(stream.finish()).rejects.toThrow();
    expect(run.usage).toMatchObject([{ state: 'estimated', quantity: '0.5' }]);
    expect(run.net.log.filter((entry) => entry.kind === 'ws-close')).toHaveLength(1);
    expect(run.net.mismatches).toHaveLength(1); // Deliberate bad control frame.
  });

  it('settles and meters a failed Finalize send', async () => {
    const run = session([{ expect: 'ws-send', match: 'binary' }]);
    const stream = await run.start();
    await stream.write(new Uint8Array(4000));
    await expect(stream.forceEndpoint?.()).rejects.toThrow();
    await expect(stream.finish()).rejects.toThrow();
    expect(run.usage).toMatchObject([{ state: 'estimated', quantity: '0.5' }]);
    expect(run.net.log.filter((entry) => entry.kind === 'ws-close')).toHaveLength(1);
    expect(run.net.mismatches).toHaveLength(1);
  });

  it('composes the v2 provider with a workspace secret and host NetPort', async () => {
    const net = createFixtureNet(
      deepgramTemplate({
        format: MULAW_8K,
        language: 'en',
        sessionId: 'composed',
        turns: [{ atMs: 0, say: 'hello' }],
      }),
    );
    const resolved: string[] = [];
    const host = definePlugin(
      {
        id: 'fixture-secret-host',
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
          resolve: async (workspace: string, credential: string) => {
            resolved.push(`${workspace}/${credential}`);
            return 'fixture-key';
          },
        });
      },
    );
    const graph = await compose(
      [
        { id: host.manifest.id },
        {
          id: deepgramPlugin.manifest.id,
          config: {
            binding: { model: 'nova-3' },
            credentialRef: { credentialRef: { credentialId: 'cred-1' } },
          },
        },
      ],
      [host, deepgramPlugin],
      { scope: 'session', workspaceId: 'w1', net },
    );
    try {
      const stt = graph.get(Cap.stt) as SpeechToText;
      const events: SttEvent[] = [];
      const stream = await stt.start({
        sessionId: 'composed',
        format: MULAW_8K,
        language: 'en',
        signal: new AbortController().signal,
        onEvent: (event) => events.push(event),
        onUsage: () => undefined,
      });
      await stream.write(new Uint8Array(800));
      await stream.finish();
      expect(events.some((event) => event.type === 'end-of-turn')).toBe(true);
      expect(resolved).toEqual(['w1/cred-1']);
      expect(graph.violations).toEqual([]);
      net.assertComplete();
    } finally {
      await graph.dispose();
    }
  });
});
