import { describe, expect, it } from 'vitest';
import { PCM16_24K, type NetPort, type UsageMeter } from '@winsendotai/ovo-contracts';
import { OpenAiTts } from '../src/tts.ts';

async function consume(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const _chunk of stream) {
    // Consume the actual production synthesis stream so its final usage is emitted.
  }
}

describe('OpenAI TTS request usage correlation', () => {
  it.each(['headerless success', 'headerless HTTP failure', 'transport failure'])(
    'keeps two same-session requests distinct after %s',
    async (scenario) => {
      let requests = 0;
      const net: NetPort = {
        async fetch() {
          requests += 1;
          if (scenario === 'transport failure') throw new Error('fixture transport failure');
          return new Response(new Uint8Array([0, 0]), {
            status: scenario === 'headerless success' ? 200 : 500,
          });
        },
        websocket() {
          throw new Error('Unexpected websocket');
        },
      };
      const provider = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
      const usage: UsageMeter[] = [];
      for (const text of ['Hello', 'Goodbye']) {
        const result = consume(
          provider.synthesize({
            sessionId: 'same-call',
            text,
            format: PCM16_24K,
            language: 'en',
            signal: new AbortController().signal,
            onUsage: (meter) => usage.push(meter),
          }),
        );
        if (scenario === 'headerless success') await result;
        else await expect(result).rejects.toThrow();
      }
      expect(requests).toBe(2);
      expect(usage).toMatchObject([
        { unit: 'characters', quantity: '5', state: 'estimated' },
        { unit: 'characters', quantity: '7', state: 'estimated' },
      ]);
      expect(usage.every((meter) => Boolean(meter.requestId))).toBe(true);
      expect(new Set(usage.map((meter) => meter.requestId)).size).toBe(2);
    },
  );

  it('retains the provider request ID on an HTTP failure', async () => {
    const net: NetPort = {
      fetch: async () =>
        new Response('fixture refusal', {
          status: 500,
          headers: { 'x-request-id': 'provider-failed-request' },
        }),
      websocket() {
        throw new Error('Unexpected websocket');
      },
    };
    const provider = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
    const usage: UsageMeter[] = [];
    await expect(
      consume(
        provider.synthesize({
          sessionId: 'same-call',
          text: 'Hello',
          format: PCM16_24K,
          language: 'en',
          signal: new AbortController().signal,
          onUsage: (meter) => usage.push(meter),
        }),
      ),
    ).rejects.toThrow('HTTP 500');
    expect(usage).toMatchObject([{ requestId: 'provider-failed-request' }]);
  });
});
