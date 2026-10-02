import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { NetFixtureScript } from '@winsendotai/ovo-contracts';
import { deferredTtsNet } from '../src/deferred-tts-net.ts';

const httpUrl = 'https://tts.fixture.test/speech';
const wsUrl = 'wss://tts.fixture.test/stream';
const script = (text: string): NetFixtureScript[] => [
  {
    host: 'tts.fixture.test',
    source: 'https://tts.fixture.test/docs',
    retrieved: '2026-10-02',
    steps: [
      {
        expect: 'http',
        method: 'POST',
        url: httpUrl,
        body: 'json',
        where: { input: text },
        reply: { status: 200, body: 'audio' },
      },
    ],
  },
];
const socketScript = (text: string): NetFixtureScript[] => [
  {
    host: 'tts.fixture.test',
    source: 'https://tts.fixture.test/docs',
    retrieved: '2026-10-02',
    steps: [
      { expect: 'ws-open', url: wsUrl },
      { expect: 'ws-send', match: 'json', where: { type: 'text', data: { text } } },
    ],
  },
];

describe('deferred TTS replay of selected provider speech', () => {
  it('matches each HTTP sentence to the generated prompt without accepting a missing tail', async () => {
    const net = deferredTtsNet([], script, new FakeClock());
    net.generated('Alpha. Beta.', 'speech-1');
    const first = await net.fetch(httpUrl, {
      method: 'POST',
      body: JSON.stringify({ input: 'Alpha.' }),
    });
    expect(first.status).toBe(200);
    net.played('speech-1');
    expect(() => net.assertComplete()).toThrow('played speech-1 before TTS synthesized: Beta.');

    const complete = deferredTtsNet([], script, new FakeClock());
    complete.generated('Alpha. Beta.', 'speech-2');
    for (const input of ['Alpha.', 'Beta.'])
      expect(
        (await complete.fetch(httpUrl, { method: 'POST', body: JSON.stringify({ input }) })).status,
      ).toBe(200);
    complete.played('speech-2');
    expect(() => complete.assertComplete()).not.toThrow();
  });

  it('allows overlapping socket opens but refuses a text frame outside the generated prompt', async () => {
    const net = deferredTtsNet([], socketScript, new FakeClock());
    net.generated('Alpha. Beta.', 'speech-3');
    const first = net.websocket(wsUrl);
    const second = net.websocket(wsUrl);
    await Promise.resolve();
    expect(first.readyState).toBe(1);
    expect(second.readyState).toBe(1);
    first.send(JSON.stringify({ type: 'text', data: { text: 'Alpha.' } }));
    second.send(JSON.stringify({ type: 'text', data: { text: 'Beta.' } }));
    net.played('speech-3');
    expect(() => net.assertComplete()).not.toThrow();

    const wrong = deferredTtsNet([], socketScript, new FakeClock());
    wrong.generated('Alpha.', 'speech-4');
    const socket = wrong.websocket(wsUrl);
    await Promise.resolve();
    expect(() => socket.send(JSON.stringify({ type: 'text', data: { text: 'Gamma.' } }))).toThrow(
      'a prefix of generated speech',
    );
  });
});
