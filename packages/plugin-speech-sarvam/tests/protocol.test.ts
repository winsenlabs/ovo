import {
  MULAW_8K,
  PCM16_8K,
  type NetFixtureScript,
  type SttEvent,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { SarvamStt, sarvamSttUrl } from '../src/stt.ts';
import { SarvamTts, sarvamTtsUrl } from '../src/tts.ts';
import { sarvamSttTemplate, sarvamTtsTemplate } from '../src/testing.ts';

const STT_SOURCE =
  'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming';

function sttScript(steps: NetFixtureScript['steps']): NetFixtureScript[] {
  return [{ host: 'api.sarvam.ai', source: STT_SOURCE, retrieved: '2026-09-26', steps }];
}

function sttInput(events: SttEvent[], usage: UsageMeter[]) {
  return {
    sessionId: 'sarvam-test',
    format: MULAW_8K,
    language: 'hi-IN',
    signal: new AbortController().signal,
    onEvent: (event: SttEvent) => events.push(event),
    onUsage: (meter: UsageMeter) => usage.push(meter),
  };
}

describe('Sarvam documented wire behavior', () => {
  it.each([1003, 1008, 4000])('maps STT close code %i to a typed failure', async (code) => {
    const net = createFixtureNet(
      sttScript([
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
          headers: { 'api-subscription-key': 'fixture-key' },
        },
        { close: { code, reason: 'provider refusal' } },
      ]),
    );
    const usage: UsageMeter[] = [];
    await expect(
      new SarvamStt(net, 'fixture-key').start(sttInput([], usage)),
    ).rejects.toMatchObject({
      name: 'SarvamSttError',
      code,
      retryable: false,
    });
    expect(usage).toMatchObject([{ state: 'estimated', requestId: 'sarvam:sarvam-test:1' }]);
    net.assertComplete();
  });

  it('refuses to script a second STT turn without an audio gate', () => {
    expect(() =>
      sarvamSttTemplate({
        format: MULAW_8K,
        language: 'hi-IN',
        sessionId: 'two-turns',
        turns: [
          { atMs: 0, say: 'पहला' },
          { atMs: 2000, say: 'दूसरा' },
        ],
      }),
    ).toThrow('multi-turn fixture requires an audio-gated replay step');
  });

  it('uses the realtime Odia code and linear16 encoding', () => {
    const url = new URL(
      sarvamSttUrl(
        { mode: 'verbatim', endpointing: 'manual' },
        { ...sttInput([], []), format: PCM16_8K, language: 'or-IN' },
      ),
    );
    expect(url.searchParams.get('language_code')).toBe('or-IN');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('mode')).toBe('verbatim');
    expect(url.searchParams.get('endpointing')).toBe('manual');
    const languages = new SarvamStt(createFixtureNet([]), 'fixture-key').capabilities.languages;
    expect(languages).toContain('or-IN');
    expect(languages).not.toContain('od-IN');
  });

  it('fails closed when a fixed STT binding language conflicts with the release language', async () => {
    const net = createFixtureNet([]);
    const stt = new SarvamStt(net, 'fixture-key', { languageCode: 'hi-IN' });
    expect(stt.capabilities.languages).toEqual(['hi-IN']);
    await expect(stt.start({ ...sttInput([], []), language: 'ta-IN' })).rejects.toThrow(
      'conflicts with ta-IN',
    );
    expect(net.log).toHaveLength(0);
  });

  it('selects the Bulbul model and completion event on the WebSocket URL', () => {
    const url = new URL(sarvamTtsUrl({ model: 'bulbul:v3' }));
    expect(url.searchParams.get('model')).toBe('bulbul:v3');
    expect(url.searchParams.get('send_completion_event')).toBe('true');
  });

  it('sends a keepalive ping during a quiet realtime STT call', async () => {
    const clock = new FakeClock();
    const net = createFixtureNet(
      sttScript([
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
          headers: { 'api-subscription-key': 'fixture-key' },
        },
        { send: JSON.stringify({ event: 'session.begin' }) },
        { expect: 'ws-send', match: 'json', where: { event: 'ping' } },
        { send: JSON.stringify({ event: 'pong' }) },
        { expect: 'ws-send', match: 'json', where: { event: 'end' } },
        { send: JSON.stringify({ event: 'session.end', audio_duration_s: 0 }) },
        { close: { code: 1000 } },
      ]),
      { clock },
    );
    const session = await new SarvamStt(net, 'fixture-key', {}, clock).start(sttInput([], []));
    clock.advance(45_000);
    await Promise.resolve();
    await session.finish();
    expect(
      net.log.some((entry) => entry.kind === 'ws-out' && entry.data === '{"event":"ping"}'),
    ).toBe(true);
    net.assertComplete();
  });

  it('exposes flush only for manual endpointing and reconciles the provider audio duration', async () => {
    const net = createFixtureNet(
      sttScript([
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
          headers: { 'api-subscription-key': 'fixture-key' },
        },
        { send: JSON.stringify({ event: 'session.begin' }) },
        { expect: 'ws-send', match: 'json', where: { event: 'audio_input' } },
        { expect: 'ws-send', match: 'json', where: { event: 'flush' } },
        { expect: 'ws-send', match: 'json', where: { event: 'end' } },
        { send: JSON.stringify({ event: 'session.end', audio_duration_s: 3.25 }) },
        { close: { code: 1000 } },
      ]),
    );
    const events: SttEvent[] = [];
    const usage: UsageMeter[] = [];
    const manual = new SarvamStt(net, 'fixture-key', { endpointing: 'manual' });
    const session = await manual.start(sttInput(events, usage));
    expect(manual.capabilities.forceEndpoint).toBe(true);
    expect(session.forceEndpoint).toBeTypeOf('function');
    await session.write(new Uint8Array(800));
    await session.forceEndpoint!();
    await session.finish();
    await session.cancel('after finish');
    expect(usage).toMatchObject([
      { requestId: 'sarvam:sarvam-test:1', quantity: '3.25', state: 'reconciled' },
    ]);
    net.assertComplete();

    const vad = new SarvamStt(createFixtureNet([]), 'fixture-key');
    expect(vad.capabilities.forceEndpoint).toBe(false);
  });

  it('incremental TTS pushes text, flushes, receives native mu-law and meters once', async () => {
    const net = createFixtureNet(
      sarvamTtsTemplate({
        format: MULAW_8K,
        language: 'hi-IN',
        sessionId: 'sarvam-test',
        turns: [],
        agentTexts: ['नमस्ते'],
      }),
    );
    const usage: UsageMeter[] = [];
    const session = await new SarvamTts(net, 'fixture-key').open({
      sessionId: 'sarvam-test',
      format: MULAW_8K,
      language: 'hi-IN',
      signal: new AbortController().signal,
      onUsage: (meter) => usage.push(meter),
    });
    session.push('नमस्ते');
    session.flush();
    const chunks: Uint8Array[] = [];
    for await (const chunk of session.audio) chunks.push(chunk);
    await session.close();
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([960, 960]);
    expect(usage).toMatchObject([
      { requestId: 'sarvam-tts-fixture', quantity: '6', state: 'reconciled' },
    ]);
    net.assertComplete();
  });

  it('REST fallback uses its own request id and emits one usage meter after a failed stream', async () => {
    const raw = String.fromCharCode(...new Uint8Array(960).fill(0x7f));
    const net = createFixtureNet([
      {
        host: 'api.sarvam.ai',
        source: 'https://docs.sarvam.ai/api-reference/text-to-speech/stream',
        retrieved: '2026-09-26',
        steps: [
          {
            expect: 'ws-open',
            url: /^wss:\/\/api\.sarvam\.ai\/text-to-speech\/ws\?/,
            headers: { 'api-subscription-key': 'fixture-key' },
          },
          {
            expect: 'ws-send',
            match: 'json',
            where: {
              type: 'config',
              data: {
                speaker: 'shubh',
                language_code: 'hi-IN',
                output_audio_codec: 'mulaw',
                speech_sample_rate: 8000,
              },
            },
          },
          { expect: 'ws-send', match: 'json', where: { type: 'text', data: { text: 'नमस्ते' } } },
          { expect: 'ws-send', match: 'json', where: { type: 'flush' } },
          { send: JSON.stringify({ type: 'error', data: { message: 'stream failed' } }) },
          {
            expect: 'http',
            method: 'POST',
            url: 'https://api.sarvam.ai/text-to-speech',
            body: 'json',
            where: {
              text: 'नमस्ते',
              language_code: 'hi-IN',
              speaker: 'shubh',
              model: 'bulbul:v3',
              output_audio_codec: 'mulaw',
              speech_sample_rate: 8000,
            },
            reply: {
              status: 200,
              body: JSON.stringify({ request_id: 'rest-1', audios: [btoa(raw)] }),
            },
          },
        ],
      },
    ]);
    const usage: UsageMeter[] = [];
    const chunks: Uint8Array[] = [];
    for await (const chunk of new SarvamTts(net, 'fixture-key', { restFallback: true }).synthesize({
      sessionId: 'sarvam-test',
      text: 'नमस्ते',
      format: MULAW_8K,
      language: 'hi-IN',
      signal: new AbortController().signal,
      onUsage: (meter) => usage.push(meter),
    }))
      chunks.push(chunk);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([960]);
    expect(usage).toMatchObject([{ requestId: 'rest-1', quantity: '6', state: 'reconciled' }]);
    net.assertComplete();
  });

  it('refuses an unsupported format before attempting WebSocket or REST fallback', async () => {
    const net = createFixtureNet([]);
    const stream = new SarvamTts(net, 'fixture-key', { restFallback: true }).synthesize({
      sessionId: 'sarvam-test',
      text: 'hello',
      format: { encoding: 'alaw', sampleRate: 8000, channels: 1 },
      language: 'hi-IN',
      signal: new AbortController().signal,
      onUsage: () => undefined,
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow('native mu-law or PCM16');
    expect(net.log).toHaveLength(0);
  });
});
