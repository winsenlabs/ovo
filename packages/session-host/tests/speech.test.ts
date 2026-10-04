import { describe, expect, it } from 'vitest';
import {
  Cap,
  type AudioFormat,
  type SpeechToText,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { adaptTextToSpeech } from '../src/speech-adapters/tts-format.ts';
import { adaptSpeechToText } from '../src/speech-adapters/stt-format.ts';
import { adaptDefinitionFormats } from '../src/speech-adapters/decorate.ts';

const MULAW: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
const PCM: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 };
const capabilities = {
  languages: ['en-IN'],
  interim: true,
  wordTimestamps: false,
  turnSignals: ['end-of-turn'] as const,
  forceEndpoint: true,
};
const usage = () => undefined;
function pcm24k(milliseconds: number) {
  const count = Math.round(milliseconds * 24);
  const bytes = new Uint8Array(count * 2);
  const view = new DataView(bytes.buffer);
  for (let sample = 0; sample < count; sample++)
    view.setInt16(
      sample * 2,
      Math.round(5000 * Math.sin((2 * Math.PI * 440 * sample) / 24000)),
      true,
    );
  return bytes;
}

describe('speech format adapters', () => {
  it('requests PCM16 24k natively and returns independently sized μ-law 8k output', async () => {
    const seen: AudioFormat[] = [];
    const identities: string[] = [];
    const tts: TextToSpeech = {
      capabilities: { ...capabilities, outputFormats: [PCM] },
      cacheIdentity(format, voice) {
        identities.push(`${format.encoding}:${format.sampleRate}:${voice}`);
        return {
          provider: 'fixture',
          model: 'model',
          voice: voice ?? '',
          revision: identities.at(-1)!,
        };
      },
      async *synthesize(input) {
        seen.push(input.format);
        yield pcm24k(60);
      },
    };
    const adapted = adaptTextToSpeech(tts);
    expect(adapted.cacheIdentity(MULAW, 'alice').revision).toBe('mulaw:8000:alice');
    expect(adapted.cacheIdentity(PCM, 'bob').revision).toBe('pcm_s16le:24000:bob');
    const bytes: number[] = [];
    for await (const chunk of adapted.synthesize({
      sessionId: 's',
      text: 'hello',
      format: MULAW,
      language: 'en-IN',
      signal: new AbortController().signal,
      onUsage: usage,
    }))
      bytes.push(...chunk);
    expect(seen).toEqual([PCM]);
    // 60 ms at 8 kHz is 480 samples. The independent source generator uses 24 samples/ms.
    expect(bytes.length).toBeGreaterThanOrEqual(460);
    expect(bytes.length).toBeLessThanOrEqual(550);
    expect(new Set(bytes).size).toBeGreaterThan(10);
  });
  it('aggregates five 20 ms carrier frames to a preferred 100 ms STT frame', async () => {
    const frames: number[] = [];
    const stt: SpeechToText = {
      capabilities: {
        ...capabilities,
        inputFormats: [MULAW],
        frameMs: { min: 50, max: 1000, preferred: 100 },
      },
      async start(input) {
        expect(input.format).toEqual(MULAW);
        return {
          write: async (frame) => {
            frames.push(frame.length);
          },
          finish: async () => undefined,
          cancel: async () => undefined,
        };
      },
    };
    const session = await adaptSpeechToText(stt).start({
      sessionId: 's',
      format: MULAW,
      language: 'en-IN',
      signal: new AbortController().signal,
      onEvent: () => undefined,
      onUsage: usage,
    });
    for (let i = 0; i < 4; i++) await session.write(new Uint8Array(160));
    expect(frames).toEqual([]);
    await session.write(new Uint8Array(160));
    expect(frames).toEqual([800]);
    await session.finish();
    await expect(session.write(new Uint8Array(160))).rejects.toThrow('closed');
  });
  it('decorates the selected provider inside a real composition', async () => {
    const native = definePlugin(
      {
        id: 'fixture-tts',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        kind: 'tts',
        provider: 'fixture',
        provides: [`${Cap.tts}@2`],
        requires: [],
        configSchema: { type: 'object' },
        secretFields: [],
        capabilities: { ...capabilities, outputFormats: [PCM] },
        meters: [{ key: 'fixture.tts', unit: 'characters', label: 'Characters', role: 'tts' }],
        runtime: { egressHosts: [], modelLicences: [] },
        conformance: ['tts@1'],
      } as never,
      (ctx) => {
        ctx.provide(
          Cap.tts as never,
          {
            capabilities: { ...capabilities, outputFormats: [PCM] },
            cacheIdentity: () => ({
              provider: 'fixture',
              model: 'model',
              voice: '',
              revision: 'v1',
            }),
            async *synthesize(input: { format: AudioFormat }) {
              expect(input.format).toEqual(PCM);
              yield pcm24k(20);
            },
          } as never,
        );
      },
    );
    const graph = await compose([{ id: 'fixture-tts' }], [adaptDefinitionFormats(native)], {
      scope: 'session',
    });
    try {
      const provider = graph.get(Cap.tts) as TextToSpeech;
      expect(provider).toBeDefined();
      const chunks: Uint8Array[] = [];
      for await (const chunk of provider.synthesize({
        sessionId: 's',
        text: 'hi',
        format: MULAW,
        language: 'en-IN',
        signal: new AbortController().signal,
        onUsage: usage,
      }))
        chunks.push(chunk);
      expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBeGreaterThan(100);
    } finally {
      await graph.dispose();
    }
  });
});
