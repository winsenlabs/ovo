import { MULAW_8K, type SttEvent, type UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { expect, it } from 'vitest';
import { AssemblyAiStt } from '../src/provider.ts';

it('maps SpeechStarted and pads a short mu-law flush with digital silence', async () => {
  const net = createFixtureNet([
    {
      host: 'streaming.assemblyai.com',
      source: 'https://www.assemblyai.com/docs/streaming/message-sequence',
      retrieved: '2026-09-29',
      steps: [
        {
          expect: 'ws-open',
          url: /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/,
          headers: { authorization: 'fixture-key' },
        },
        {
          send: JSON.stringify({
            type: 'Begin',
            id: 'speech-start-fixture',
            expires_at: '2026-09-29T00:00:00Z',
          }),
        },
        { send: JSON.stringify({ type: 'SpeechStarted', timestamp: 123 }) },
        { expect: 'ws-send', match: 'binary' },
        { expect: 'ws-send', match: 'json', where: { type: 'ForceEndpoint' } },
        { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
        { send: JSON.stringify({ type: 'Termination', session_duration_seconds: 0.02 }) },
      ],
    },
  ]);
  const events: SttEvent[] = [];
  const usage: UsageMeter[] = [];
  const session = await new AssemblyAiStt(net, 'fixture-key').start({
    sessionId: 'short-assembly',
    format: MULAW_8K,
    language: 'en',
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    onUsage: (meter) => usage.push(meter),
  });
  await session.write(new Uint8Array(160).fill(0x12));
  await session.forceEndpoint!();
  await session.finish();
  expect(events).toContainEqual({ type: 'speech-start', atMs: 123 });
  const frames = net.log.flatMap((entry) =>
    entry.kind === 'ws-out' && entry.data instanceof Uint8Array ? [entry.data] : [],
  );
  expect(frames).toHaveLength(1);
  expect(frames[0]?.byteLength).toBe(400);
  expect(frames[0]?.slice(0, 160)).toEqual(new Uint8Array(160).fill(0x12));
  expect(frames[0]?.slice(160)).toEqual(new Uint8Array(240).fill(0xff));
  expect(usage).toMatchObject([{ requestId: 'speech-start-fixture', state: 'reconciled' }]);
  net.assertComplete();
});
