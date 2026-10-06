import { describe, expect, it } from 'vitest';
import { PCM16_24K, type NetPort } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { OpenAiTts } from '../src/tts.ts';

describe('OpenAI TTS warm-up (Wave 4 deferred)', () => {
  it('opens the speech host connection with a free model lookup, and drains it', async () => {
    const net = createFixtureNet([
      {
        host: 'api.openai.com',
        source: 'https://developers.openai.com/api/reference/resources/models',
        retrieved: '2026-10-06',
        steps: [
          {
            expect: 'http',
            method: 'GET',
            url: 'https://api.openai.com/v1/models/gpt-4o-mini-tts',
            headers: { authorization: 'Bearer fixture-key' },
            reply: {
              status: 200,
              body: JSON.stringify({ id: 'gpt-4o-mini-tts', object: 'model', owned_by: 'system' }),
            },
          },
        ],
      },
    ]);
    const tts = new OpenAiTts(net, 'fixture-key', {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      warmUp: true,
    });
    await expect(tts.warm({ format: PCM16_24K })).resolves.toBeUndefined();
    net.assertComplete();
  });

  it('sends nothing unless the binding opts in', async () => {
    const net = createFixtureNet([]);
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
    await tts.warm({ format: PCM16_24K });
    expect(net.log).toEqual([]);
    net.assertComplete();
  });

  it('never rejects: a refused key or a dead network leaves the first synthesis to connect', async () => {
    for (const fetch of [
      async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
      async () => {
        throw new Error('ECONNRESET');
      },
    ]) {
      const net = { fetch, websocket: () => undefined as never } as NetPort;
      const tts = new OpenAiTts(net, 'fixture-key', {
        model: 'tts-1',
        voice: 'alloy',
        warmUp: true,
      });
      await expect(tts.warm({ format: PCM16_24K })).resolves.toBeUndefined();
    }
  });
});
