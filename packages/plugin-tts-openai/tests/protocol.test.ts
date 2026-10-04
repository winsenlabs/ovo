import { describe, expect, it } from 'vitest';
import {
  Cap,
  MULAW_8K,
  PCM16_24K,
  type NetPort,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { mulawToPcm16 } from '@winsendotai/ovo-audio';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { adaptTextToSpeech } from '../../session-host/src/speech-adapters/tts-format.ts';
import { openAiTtsPlugin } from '../src/index.ts';
import { openAiTtsTemplate } from '../src/testing.ts';
import { OpenAiTts } from '../src/tts.ts';

const source = 'https://platform.openai.com/docs/api-reference/audio/createSpeech';
const speechUrl = 'https://api.openai.com/v1/audio/speech';
function pcmTone(freq: number, seconds = 0.8): Uint8Array {
  const out = new Uint8Array(Math.round(24000 * seconds) * 2);
  for (let i = 0; i < out.byteLength / 2; i += 1) {
    const value = Math.round(12000 * Math.sin((2 * Math.PI * freq * i) / 24000));
    out[i * 2] = value & 255;
    out[i * 2 + 1] = (value >> 8) & 255;
  }
  return out;
}
function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function netFor(model: string, chunks: Uint8Array[]) {
  return createFixtureNet([
    {
      host: 'api.openai.com',
      source,
      retrieved: '2026-09-25',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: speechUrl,
          headers: { authorization: 'Bearer fixture-key' },
          body: 'json',
          where: { model, response_format: 'pcm' },
          reply: {
            status: 200,
            headers: { 'x-request-id': 'tts-real-id' },
            chunks: chunks.map((bytes) => ({ base64: base64(bytes) })),
          },
        },
      ],
    },
  ]);
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
function amplitude(signal: Int16Array, rate: number, freq: number): number {
  const steady = signal.subarray(Math.round(rate * 0.1), Math.round(rate * 0.6));
  let re = 0;
  let im = 0;
  for (let i = 0; i < steady.length; i += 1) {
    const phase = (2 * Math.PI * freq * i) / rate;
    re += steady[i]! * Math.cos(phase);
    im -= steady[i]! * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / steady.length;
}

describe('OpenAI TTS documented wire protocol', () => {
  it('reports elapsed usage from the injected clock', async () => {
    const clock = new FakeClock(100);
    const net: NetPort = {
      async fetch() {
        clock.advance(37);
        return new Response(pcmTone(300, 0.1).buffer as ArrayBuffer, { status: 200 });
      },
      websocket: () => {
        throw new Error('Unexpected websocket');
      },
    };
    const usage: UsageMeter[] = [];
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' }, clock);
    await collect(
      tts.synthesize({
        sessionId: 'clock',
        text: 'Hi',
        format: PCM16_24K,
        language: 'en',
        signal: new AbortController().signal,
        onUsage: (meter) => usage.push(meter),
      }),
    );
    expect(usage).toMatchObject([{ elapsedMs: 37 }]);
  });
  it('joins odd-byte raw PCM chunks without dropping a sample', async () => {
    const bytes = pcmTone(300, 0.1);
    const net = netFor('tts-1', [bytes.slice(0, 101), bytes.slice(101, 777), bytes.slice(777)]);
    const usage: UsageMeter[] = [];
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
    const output = await collect(
      tts.synthesize({
        sessionId: 's1',
        text: 'Hello',
        format: PCM16_24K,
        language: 'en',
        signal: new AbortController().signal,
        onUsage: (meter) => usage.push(meter),
      }),
    );
    expect(output).toEqual(bytes);
    expect(usage).toMatchObject([
      { unit: 'characters', quantity: '5', state: 'estimated', requestId: 'tts-real-id' },
    ]);
    net.assertComplete();
  });

  it('joins a large chunk after a one-byte split without overflowing the stack', async () => {
    const bytes = new Uint8Array(200_002);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i & 255;
    const net = netFor('tts-1', [bytes.slice(0, 1), bytes.slice(1)]);
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
    expect(
      await collect(
        tts.synthesize({
          sessionId: 's1',
          text: 'Long audio',
          format: PCM16_24K,
          language: 'en',
          signal: new AbortController().signal,
          onUsage: () => undefined,
        }),
      ),
    ).toEqual(bytes);
    net.assertComplete();
  });

  it('takes mini TTS token usage from speech.audio.done over SSE', async () => {
    const bytes = pcmTone(300, 0.1);
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const body =
      event({ type: 'speech.audio.delta', audio: base64(bytes) }) +
      event({
        type: 'speech.audio.done',
        usage: { input_tokens: 7, output_tokens: 19, total_tokens: 26 },
      });
    const net = createFixtureNet([
      {
        host: 'api.openai.com',
        source,
        retrieved: '2026-09-25',
        steps: [
          {
            expect: 'http',
            method: 'POST',
            url: speechUrl,
            where: { model: 'gpt-4o-mini-tts', stream_format: 'sse' },
            reply: { status: 200, headers: { 'x-request-id': 'tts-sse-id' }, body },
          },
        ],
      },
    ]);
    const usage: UsageMeter[] = [];
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'gpt-4o-mini-tts', voice: 'alloy' });
    expect(
      await collect(
        tts.synthesize({
          sessionId: 's1',
          text: 'Hello',
          format: PCM16_24K,
          language: 'en',
          signal: new AbortController().signal,
          onUsage: (meter) => usage.push(meter),
        }),
      ),
    ).toEqual(bytes);
    expect(usage).toMatchObject([
      { unit: 'input_tokens', quantity: '7', state: 'reconciled', requestId: 'tts-sse-id' },
      { unit: 'audio_output_tokens', quantity: '19', state: 'reconciled', requestId: 'tts-sse-id' },
    ]);
    net.assertComplete();
  });

  it.each([429, 500])(
    'surfaces HTTP %i and emits one request-correlated estimate',
    async (status) => {
      const net = createFixtureNet([
        {
          host: 'api.openai.com',
          source,
          retrieved: '2026-09-25',
          steps: [
            {
              expect: 'http',
              method: 'POST',
              url: speechUrl,
              headers: { authorization: 'Bearer fixture-key' },
              reply: { status, body: JSON.stringify({ error: { message: 'fixture refusal' } }) },
            },
          ],
        },
      ]);
      const usage: UsageMeter[] = [];
      const tts = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
      await expect(
        collect(
          tts.synthesize({
            sessionId: 's1',
            text: 'Hello',
            format: PCM16_24K,
            language: 'en',
            signal: new AbortController().signal,
            onUsage: (meter) => usage.push(meter),
          }),
        ),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(usage).toMatchObject([
        { unit: 'characters', state: 'estimated', requestId: 'openai:s1:1' },
      ]);
      net.assertComplete();
    },
  );

  it.each(['tts-1', 'gpt-4o-mini-tts'] as const)(
    'cancels the %s provider body when the consumer stops early',
    async (model) => {
      let cancels = 0;
      const bytes = pcmTone(300, 0.1);
      const body =
        model === 'tts-1'
          ? bytes
          : new TextEncoder().encode(
              `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: base64(bytes) })}\n\n`,
            );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
        },
        cancel() {
          cancels += 1;
        },
      });
      const net: NetPort = {
        fetch: async () => new Response(stream, { status: 200 }),
        websocket: () => {
          throw new Error('Unexpected websocket');
        },
      };
      const usage: UsageMeter[] = [];
      const tts = new OpenAiTts(net, 'fixture-key', { model, voice: 'alloy' });
      const iterator = tts
        .synthesize({
          sessionId: 's1',
          text: 'Hello',
          format: PCM16_24K,
          language: 'en',
          signal: new AbortController().signal,
          onUsage: (meter) => usage.push(meter),
        })
        [Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      await iterator.return?.();
      expect(cancels).toBe(1);
      expect(usage).toHaveLength(model === 'tts-1' ? 1 : 2);
    },
  );

  it.each([4400, 4600, 6000])(
    'attenuates the %i Hz stopband alias by at least 60 dB through the real host TTS adapter',
    async (stopbandHz) => {
      const render = async (freq: number) => {
        const net = netFor('tts-1', [pcmTone(freq).slice(0, 101), pcmTone(freq).slice(101)]);
        const tts = adaptTextToSpeech(
          new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' }),
        );
        const output = await collect(
          tts.synthesize({
            sessionId: 's1',
            text: 'Tone',
            format: MULAW_8K,
            language: 'en',
            signal: new AbortController().signal,
            onUsage: () => undefined,
          }),
        );
        net.assertComplete();
        return mulawToPcm16(output);
      };
      const reference = amplitude(await render(1000), 8000, 1000);
      const folded = amplitude(await render(stopbandHz), 8000, 8000 - stopbandHz);
      expect(20 * Math.log10(folded / reference)).toBeLessThanOrEqual(-60);
    },
  );

  it('composes the v2 provider with a workspace secret and host NetPort', async () => {
    const net = createFixtureNet(
      openAiTtsTemplate({
        format: PCM16_24K,
        language: 'en',
        sessionId: 'composed',
        turns: [],
        agentTexts: ['Hello'],
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
          id: openAiTtsPlugin.manifest.id,
          config: {
            binding: { model: 'gpt-4o-mini-tts', voice: 'alloy' },
            credentialRef: { credentialRef: { credentialId: 'cred-1' } },
          },
        },
      ],
      [host, openAiTtsPlugin],
      { scope: 'session', workspaceId: 'w1', net },
    );
    try {
      const tts = graph.get(Cap.tts) as TextToSpeech;
      const audio = await collect(
        tts.synthesize({
          sessionId: 'composed',
          text: 'Hello',
          format: PCM16_24K,
          language: 'en',
          signal: new AbortController().signal,
          onUsage: () => undefined,
        }),
      );
      expect(audio.byteLength).toBeGreaterThan(0);
      expect(resolved).toEqual(['w1/cred-1']);
      expect(graph.violations).toEqual([]);
      net.assertComplete();
    } finally {
      await graph.dispose();
    }
  });
});
