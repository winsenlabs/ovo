import { MULAW_8K, type SttEvent, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { expect, it } from 'vitest';
import { SarvamStt } from '../src/stt.ts';

it('maps both VAD signals and pads a short JSON-framed audio flush with mu-law silence', async () => {
  const net = createFixtureNet([
    {
      host: 'api.sarvam.ai',
      source: 'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming',
      retrieved: '2026-09-29',
      steps: [
        {
          expect: 'ws-open',
          url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
          headers: { 'api-subscription-key': 'fixture-key' },
        },
        { send: JSON.stringify({ event: 'session.begin' }) },
        { send: JSON.stringify({ event: 'vad.speech_start' }) },
        { send: JSON.stringify({ event: 'vad.speech_end' }) },
        { expect: 'ws-send', match: 'json', where: { event: 'audio_input' } },
        { expect: 'ws-send', match: 'json', where: { event: 'end' } },
        { send: JSON.stringify({ event: 'transcript.partial', text: 'nam' }) },
        { send: JSON.stringify({ event: 'transcript.final', text: 'namaste' }) },
        { send: JSON.stringify({ event: 'session.end', audio_duration_s: 0.02 }) },
      ],
    },
  ]);
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const stt = new SarvamStt(net, 'fixture-key');
  expect(stt.capabilities.forceEndpoint).toBe(false);
  const session = await stt.start({
    sessionId: 'short-sarvam',
    format: MULAW_8K,
    language: 'hi-IN',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onUsage: (meter) => usage.push(meter),
  });
  expect(session.forceEndpoint).toBeUndefined();
  await session.write(new Uint8Array(5).fill(0x12));
  await session.finish();
  expect(events.map((event) => event.type)).toEqual([
    'speech-start',
    'speech-end',
    'transcript',
    'transcript',
    'end-of-turn',
  ]);
  expect(events.filter((event) => event.type === 'transcript')).toMatchObject([
    { segment: { text: 'nam', stability: 'interim' } },
    { segment: { text: 'namaste', stability: 'final' } },
  ]);
  const audioFrame = net.log.find(
    (entry) =>
      entry.kind === 'ws-out' &&
      typeof entry.data === 'string' &&
      entry.data.includes('"audio_input"'),
  );
  expect(audioFrame).toBeDefined();
  const audio = JSON.parse(String(audioFrame?.data)) as { audio: string };
  const bytes = Uint8Array.from(atob(audio.audio), (char) => char.charCodeAt(0));
  expect(bytes.byteLength).toBe(160);
  expect(bytes.slice(0, 5)).toEqual(new Uint8Array(5).fill(0x12));
  expect(bytes.slice(5)).toEqual(new Uint8Array(155).fill(0xff));
  expect(usage).toMatchObject([{ quantity: '0.02', state: 'reconciled' }]);
  net.assertComplete();
});
