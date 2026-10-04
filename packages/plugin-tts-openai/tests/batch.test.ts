import { expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { OpenAiBatchTranscriber } from '../src/batch.ts';
import { createMonoWav } from '../src/batch-wav.ts';

const binding = {
  workspaceId: 'workspace',
  bindingVersion: 'batch:v1',
  credentialId: 'credential',
  model: 'gpt-4o-mini-transcribe',
  language: 'en',
  requestTimeoutMs: 1000,
  maxAudioBytes: 1024,
  maxResponseBytes: 1024,
};
const secrets = {
  async resolve(workspace: string, credential: string) {
    expect([workspace, credential]).toEqual(['workspace', 'credential']);
    return 'fixture-key';
  },
};

it('sends batch audio through FixtureNet and keeps omitted usage unavailable', async () => {
  const clock = new FakeClock(100);
  const net = createFixtureNet([
    {
      host: 'api.openai.com',
      source: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
      retrieved: '2026-09-25',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: 'https://api.openai.com/v1/audio/transcriptions',
          headers: { authorization: 'Bearer fixture-key' },
          body: 'any',
          reply: {
            status: 200,
            headers: { 'x-request-id': 'batch-request' },
            body: JSON.stringify({ text: 'hello batch', duration: 0.02 }),
          },
        },
      ],
    },
  ]);
  const usage = [] as unknown[];
  const transcriber = await OpenAiBatchTranscriber.create(binding, {
    secrets,
    clock,
    net: {
      fetch: async (url, init) => {
        const response = await net.fetch(url, init);
        clock.advance(17);
        return response;
      },
    },
    usage: (meter) => usage.push(meter),
  });
  const result = await transcriber.transcribe({
    audio: Uint8Array.from([0xff, 0x7f]),
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    text: 'hello batch',
    durationSeconds: 0.02,
    requestId: 'batch-request',
    usage: { state: 'unavailable', missing: 'provider-omitted', elapsedMs: 17 },
  });
  expect(usage).toEqual([result.usage]);
  const sent = String(net.log.find((entry) => entry.kind === 'http')?.data);
  expect(sent).toContain('gpt-4o-mini-transcribe');
  expect(sent).toContain('RIFF');
  net.assertComplete();
});

it('rejects oversized input before egress and writes correct PCM and mu-law WAV envelopes', async () => {
  const net = createFixtureNet([]);
  const transcriber = await OpenAiBatchTranscriber.create(binding, { secrets, net });
  await expect(
    transcriber.transcribe({
      audio: new Uint8Array(1025),
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('configured byte limit');
  expect(net.log).toHaveLength(0);
  const mulaw = createMonoWav(Uint8Array.from([0xff, 0x7f]), 'audio/x-mulaw', 8000);
  const pcm = createMonoWav(Uint8Array.from([1, 0, 255, 255]), 'audio/pcm', 24000);
  expect(new TextDecoder().decode(mulaw.slice(0, 4))).toBe('RIFF');
  expect(new DataView(mulaw.buffer).getUint16(20, true)).toBe(7);
  expect(new TextDecoder().decode(mulaw.slice(38, 42))).toBe('fact');
  expect(new DataView(pcm.buffer).getUint16(20, true)).toBe(1);
  expect(new DataView(pcm.buffer).getUint16(34, true)).toBe(16);
});

it('bounds provider responses and rejects malformed JSON through FixtureNet', async () => {
  for (const [body, message] of [
    ['x'.repeat(1025), 'configured byte limit'],
    ['{bad-json', 'malformed JSON'],
  ]) {
    const net = createFixtureNet([
      {
        host: 'api.openai.com',
        source: 'https://platform.openai.com/docs/api-reference/audio/createTranscription',
        retrieved: '2026-09-25',
        steps: [
          {
            expect: 'http',
            method: 'POST',
            url: 'https://api.openai.com/v1/audio/transcriptions',
            body: 'any',
            reply: { status: 200, body },
          },
        ],
      },
    ]);
    const transcriber = await OpenAiBatchTranscriber.create(binding, { secrets, net });
    await expect(
      transcriber.transcribe({
        audio: Uint8Array.from([0xff]),
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(message);
    net.assertComplete();
  }
});

it('snapshots the binding before asynchronous secret resolution and refuses unsafe endpoints', async () => {
  const net = createFixtureNet([]);
  const mutable = { ...binding };
  let release!: (key: string) => void;
  const pending = OpenAiBatchTranscriber.create(mutable, {
    net,
    secrets: {
      resolve: async () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    },
  });
  mutable.model = 'tampered-model';
  mutable.credentialId = 'tampered-credential';
  release('fixture-key');
  const transcriber = await pending;
  expect(transcriber.binding.model).toBe(binding.model);
  expect(transcriber.binding.credentialId).toBe(binding.credentialId);
  for (const endpoint of [
    'http://api.openai.com/v1/audio/transcriptions',
    'https://127.0.0.1/v1/audio/transcriptions',
  ]) {
    await expect(
      OpenAiBatchTranscriber.create(binding, { secrets, net, endpoint }),
    ).rejects.toThrow(/HTTPS|Private provider endpoints/);
  }
  expect(net.log).toHaveLength(0);
});

it('honors an aborted call before egress', async () => {
  const net = createFixtureNet([]);
  const transcriber = await OpenAiBatchTranscriber.create(binding, { secrets, net });
  const controller = new AbortController();
  controller.abort(new DOMException('call ended', 'AbortError'));
  await expect(
    transcriber.transcribe({
      audio: Uint8Array.from([0xff]),
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      signal: controller.signal,
    }),
  ).rejects.toThrow('call ended');
  expect(net.log).toHaveLength(0);
});

it('cancels an in-flight batch request on the injected deadline clock', async () => {
  const clock = new FakeClock(100);
  let called = 0;
  const transcriber = await OpenAiBatchTranscriber.create(
    { ...binding, requestTimeoutMs: 25 },
    {
      secrets,
      clock,
      net: {
        fetch: async (_url, init) => {
          called += 1;
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          });
        },
      },
    },
  );
  const pending = transcriber.transcribe({
    audio: Uint8Array.from([0xff]),
    codec: 'audio/x-mulaw',
    sampleRate: 8000,
    signal: new AbortController().signal,
  });
  expect(called).toBe(1);
  clock.advance(25);
  await expect(pending).rejects.toThrow('OpenAI transcription deadline exceeded');
  expect(clock.pendingTimers).toBe(0);
});
