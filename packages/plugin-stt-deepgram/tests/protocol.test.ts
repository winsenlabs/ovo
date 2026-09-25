import { describe, expect, it } from 'vitest';
import { MULAW_8K, type SttEvent, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { DeepgramStt, listenUrl } from '../src/deepgram.ts';

const source = 'https://developers.deepgram.com/reference/speech-to-text/listen-streaming';
const result = (text: string, final: boolean, speechFinal: boolean, fromFinalize = false) =>
  JSON.stringify({ type: 'Results', duration: 99, start: 0, is_final: final,
    speech_final: speechFinal, from_finalize: fromFinalize,
    channel: { alternatives: [{ transcript: text, words: [] }] } });

function session(steps: Parameters<typeof createFixtureNet>[0][number]['steps']) {
  const net = createFixtureNet([{ host: 'api.deepgram.com', source, retrieved: '2026-09-25',
    steps: [{ expect: 'ws-open', url: /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/, headers: { authorization: 'Token fixture-key' } }, ...steps] }]);
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const stt = new DeepgramStt(net, 'fixture-key');
  const start = () => stt.start({ sessionId: 's1', format: MULAW_8K, language: 'en',
    signal: new AbortController().signal, onEvent: (event) => events.push(event),
    onUsage: (meter) => usage.push(meter) });
  return { net, events, usage, start };
}

describe('Deepgram documented wire protocol', () => {
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
      'speech-start', 'transcript', 'transcript', 'end-of-turn', 'utterance-end',
    ]);
    expect(run.usage).toMatchObject([{ state: 'reconciled', quantity: '1.2', requestId: 'dg-real-id' }]);
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
    expect(run.usage).toMatchObject([{ state: 'estimated', quantity: '1', requestId: 'deepgram:s1:1' }]);
    expect(run.events).toContainEqual({ type: 'end-of-turn' });
    run.net.assertComplete();
  });

  it('builds format-specific queries and repeats keyterms', () => {
    const url = new URL(listenUrl({ encoding: 'pcm_s16le', sampleRate: 16000, channels: 1 },
      'hi', { model: 'nova-3', keyterms: ['restaurant', 'book a table'] }));
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.getAll('keyterm')).toEqual(['restaurant', 'book a table']);
  });
});
