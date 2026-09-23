import { VadParamsSchema, type VadAnalyzerFactory } from '@winsendotai/ovo-contracts';
import { silencePcm16, speechLikePcm16 } from '../drivers/audio-gen.ts';
import { Failures, type KitCheck } from './runner.ts';

export type VadFactory = () => VadAnalyzerFactory | Promise<VadAnalyzerFactory>;

export interface VadKitContext {
  factory: VadFactory;
}

function frames(pcm: Int16Array, size: number): Int16Array[] {
  const out: Int16Array[] = [];
  for (let i = 0; i + size <= pcm.length; i += size) out.push(pcm.slice(i, i + size));
  return out;
}

export const VAD_CHECKS: readonly KitCheck<VadKitContext>[] = [
  {
    name: 'params are within the documented ranges',
    async run({ factory }) {
      const vad = await factory();
      const parsed = VadParamsSchema.safeParse(vad.params);
      return parsed.success ? [] : [`params rejected: ${parsed.error.message}`];
    },
  },
  {
    name: 'analyzers exist for 8 kHz and 16 kHz',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      for (const rate of [8000, 16000] as const) {
        const analyzer = vad.create(rate);
        f.expect(analyzer.sampleRate === rate, `create(${rate}) reports ${analyzer.sampleRate}`);
        f.expect(analyzer.frameSamples > 0, `create(${rate}) has no frame size`);
      }
      return f.messages;
    },
  },
  {
    name: 'silence stays below and speech crosses the confidence threshold',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      for (const rate of [8000, 16000] as const) {
        const analyzer = vad.create(rate);
        const quiet = frames(silencePcm16(1000, rate), analyzer.frameSamples).map((frame) =>
          analyzer.confidence(frame),
        );
        f.expect(
          Math.max(...quiet) < vad.params.confidence,
          `${rate} Hz: silence reached ${Math.max(...quiet)}`,
        );
        analyzer.reset();
        const voiced = frames(
          speechLikePcm16({ seed: 7, ms: 1000, rate }),
          analyzer.frameSamples,
        ).map((frame) => analyzer.confidence(frame));
        f.expect(
          Math.max(...voiced) >= vad.params.confidence,
          `${rate} Hz: speech peaked at ${Math.max(...voiced)}`,
        );
      }
      return f.messages;
    },
  },
  {
    name: 'volume is normalised and analysis is deterministic after reset',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      const analyzer = vad.create(16000);
      const input = frames(
        speechLikePcm16({ seed: 3, ms: 500, rate: 16000 }),
        analyzer.frameSamples,
      );
      const first = input.map((frame) => analyzer.confidence(frame));
      analyzer.reset();
      const second = input.map((frame) => analyzer.confidence(frame));
      f.expect(
        JSON.stringify(first) === JSON.stringify(second),
        'the same input gave different confidences after reset',
      );
      for (const frame of input) {
        const volume = analyzer.volume(frame);
        f.expect(volume >= 0 && volume <= 1, `volume ${volume} is outside [0, 1]`);
      }
      return f.messages;
    },
  },
];
