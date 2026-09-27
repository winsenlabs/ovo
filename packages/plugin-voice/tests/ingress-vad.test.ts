import { expect, it, vi } from 'vitest';
import {
  DEFAULT_VAD_PARAMS,
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  type AudioFormat,
  type VadParams,
  type VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { VoiceIngress } from '../src/engine/ingress.ts';

async function setup(
  format: AudioFormat,
  params: VadParams = DEFAULT_VAD_PARAMS,
  observe?: (event: VoiceEvent) => void,
) {
  const carrier = createFakeCarrier({ format });
  const events: VoiceEvent[] = [];
  const frames: number[][] = [];
  const writes: number[][] = [];
  const operations: string[] = [];
  const samples = format.sampleRate / 50;
  const check = (pcm: Int16Array) => {
    if (pcm.length !== samples)
      throw new RangeError(`expected ${samples} PCM samples per 20 ms frame`);
  };
  const ingress = new VoiceIngress(
    carrier.duplex,
    { maxFrames: 100, maxBytes: 100_000, preSttBufferMs: 5000 },
    new AbortController().signal,
    (event) => {
      events.push(event);
      observe?.(event);
    },
    () => {
      throw new Error('unexpected ingress failure');
    },
    {
      params,
      create: () => ({
        frameSamples: samples,
        sampleRate: format.sampleRate as 8000 | 16000,
        confidence(pcm) {
          check(pcm);
          frames.push([...pcm]);
          return pcm.some((sample) => sample !== 0) ? 1 : 0;
        },
        volume(pcm) {
          check(pcm);
          return 1;
        },
        reset() {},
      }),
    },
  );
  await ingress.connect(
    {
      capabilities: {
        inputFormats: [format],
        languages: ['en-US'],
        interim: false,
        wordTimestamps: false,
        turnSignals: [],
        forceEndpoint: true,
      },
      async start() {
        return {
          async write(bytes) {
            operations.push(`audio:${bytes.length}`);
            writes.push([...bytes]);
          },
          async forceEndpoint() {
            operations.push('force-endpoint');
          },
          async finish() {},
          async cancel() {},
        };
      },
    },
    'en-US',
    () => undefined,
  );
  return { carrier, ingress, events, frames, writes, operations };
}

function audio(format: AudioFormat, ms: number, active = true): Uint8Array {
  const samples = (format.sampleRate * ms) / 1000;
  if (format.encoding === 'mulaw') return new Uint8Array(samples).fill(active ? 0 : 0xff);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let sample = 0; sample < samples; sample++)
    view.setInt16(sample * 2, active ? 1000 : 0, true);
  return bytes;
}

it.each(
  [MULAW_8K, PCM16_8K, PCM16_16K].flatMap((format) => [10, 20, 100].map((ms) => ({ format, ms }))),
)(
  'reframes $ms ms $format.encoding/$format.sampleRate carrier chunks only for strict VAD',
  async ({ format, ms }) => {
    const run = await setup(format);
    const original: number[][] = [];
    try {
      for (let at = 0; at < 200; at += ms) {
        const bytes = audio(format, ms);
        original.push([...bytes]);
        expect(() => run.carrier.caller.audio(bytes)).not.toThrow();
      }
      expect(run.frames).toHaveLength(10);
      expect(run.events.map((event) => event.type)).toEqual(['vad.start']);
      await vi.waitFor(() => expect(run.writes).toHaveLength(original.length));
      expect(run.writes).toEqual(original);
    } finally {
      await run.ingress.dispose();
    }
  },
);

it('requires ten consecutive 20 ms frames for default 200 ms start and stop', async () => {
  const run = await setup(MULAW_8K);
  const speech = () => run.carrier.caller.audio(audio(MULAW_8K, 20));
  const silence = () => run.carrier.caller.audio(audio(MULAW_8K, 20, false));
  try {
    speech();
    expect(run.events).toEqual([]);
    silence();
    for (let frame = 0; frame < 9; frame++) speech();
    expect(run.events).toEqual([]);
    speech();
    expect(run.events.map((event) => event.type)).toEqual(['vad.start']);
    for (let frame = 0; frame < 9; frame++) silence();
    expect(run.events.map((event) => event.type)).toEqual(['vad.start']);
    speech();
    for (let frame = 0; frame < 9; frame++) silence();
    expect(run.events.map((event) => event.type)).toEqual(['vad.start']);
    silence();
    expect(run.events.map((event) => event.type)).toEqual(['vad.start', 'vad.stop']);
  } finally {
    await run.ingress.dispose();
  }
});

it('retains split PCM sample bytes across carrier chunks without changing STT writes', async () => {
  const run = await setup(PCM16_8K);
  const pcm = Array.from({ length: 1600 }, (_, index) => ((index * 79) % 65536) - 32768);
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  pcm.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  const cuts = [0, 1, 158, 321, 328, 641, bytes.length];
  const chunks = cuts.slice(1).map((end, index) => bytes.slice(cuts[index], end));
  try {
    for (const chunk of chunks) expect(() => run.carrier.caller.audio(chunk)).not.toThrow();
    expect(run.frames.flat()).toEqual(pcm);
    expect(run.frames).toHaveLength(10);
    await vi.waitFor(() => expect(run.writes).toHaveLength(chunks.length));
    expect(run.writes).toEqual(chunks.map((chunk) => [...chunk]));
  } finally {
    await run.ingress.dispose();
  }
});

it('uses the selected factory start and stop durations independently', async () => {
  const run = await setup(MULAW_8K, { ...DEFAULT_VAD_PARAMS, startMs: 40, stopMs: 60 });
  try {
    run.carrier.caller.audio(audio(MULAW_8K, 20));
    expect(run.events).toEqual([]);
    run.carrier.caller.audio(audio(MULAW_8K, 20));
    expect(run.events.map((event) => event.type)).toEqual(['vad.start']);
    run.carrier.caller.audio(audio(MULAW_8K, 40, false));
    expect(run.events.map((event) => event.type)).toEqual(['vad.start']);
    run.carrier.caller.audio(audio(MULAW_8K, 20, false));
    expect(run.events.map((event) => event.type)).toEqual(['vad.start', 'vad.stop']);
  } finally {
    await run.ingress.dispose();
  }
});

it('sends the triggering carrier bytes before a synchronous VAD-stop endpoint', async () => {
  let ingress!: VoiceIngress;
  const run = await setup(MULAW_8K, { ...DEFAULT_VAD_PARAMS, startMs: 20, stopMs: 20 }, (event) => {
    if (event.type === 'vad.stop') void ingress.forceEndpoint();
  });
  ingress = run.ingress;
  try {
    run.carrier.caller.audio(
      Uint8Array.from([...audio(MULAW_8K, 20), ...audio(MULAW_8K, 20, false)]),
    );
    await vi.waitFor(() => expect(run.operations).toHaveLength(2));
    expect(run.operations).toEqual(['audio:320', 'force-endpoint']);
  } finally {
    await ingress.dispose();
  }
});
