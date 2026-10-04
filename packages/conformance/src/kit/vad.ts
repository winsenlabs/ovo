import {
  VadParamsSchema,
  type VadAnalyzer,
  type VadAnalyzerFactory,
} from '@winsendotai/ovo-contracts';
import { silencePcm16, speechLikePcm16, tonePcm16 } from '../drivers/audio-gen.ts';
import { Failures, type KitCheck } from './runner.ts';

export type VadFactory = () => VadAnalyzerFactory | Promise<VadAnalyzerFactory>;

export interface VadKitContext {
  factory: VadFactory;
}

const RATES = [8000, 16000] as const;
/** A frame shorter than 5 ms or longer than 100 ms cannot carry the declared start/stop windows. */
const MIN_FRAME_MS = 5;
const MAX_FRAME_MS = 100;

function frames(pcm: Int16Array, size: number): Int16Array[] {
  const out: Int16Array[] = [];
  for (let i = 0; i + size <= pcm.length; i += size) out.push(pcm.slice(i, i + size));
  return out;
}

const frameMs = (analyzer: VadAnalyzer) => (analyzer.frameSamples / analyzer.sampleRate) * 1000;

/** Confidences for `pcm`, checking the [0, 1] range of every one of them on the way (#F19). */
function confidences(f: Failures, analyzer: VadAnalyzer, pcm: Int16Array, what: string): number[] {
  return frames(pcm, analyzer.frameSamples).map((frame, index) => {
    const value = analyzer.confidence(frame);
    f.expect(
      typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
      `${what}: confidence(frame ${index}) is ${value}, outside [0, 1]`,
    );
    return value;
  });
}

const volumeOf = (f: Failures, analyzer: VadAnalyzer, pcm: Int16Array, what: string): number => {
  const frame = frames(pcm, analyzer.frameSamples)[0] ?? new Int16Array(analyzer.frameSamples);
  const value = analyzer.volume(frame);
  f.expect(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    `${what}: volume is ${value}, outside [0, 1]`,
  );
  return value;
};

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
    name: 'analyzers exist for 8 kHz and 16 kHz with a usable frame size',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      for (const rate of RATES) {
        const analyzer = vad.create(rate);
        f.expect(analyzer.sampleRate === rate, `create(${rate}) reports ${analyzer.sampleRate}`);
        if (!f.expect(analyzer.frameSamples > 0, `create(${rate}) has no frame size`)) continue;
        const ms = frameMs(analyzer);
        f.expect(
          ms >= MIN_FRAME_MS && ms <= MAX_FRAME_MS,
          `create(${rate}) has ${analyzer.frameSamples} samples per frame (${ms.toFixed(2)} ms), outside ${MIN_FRAME_MS}–${MAX_FRAME_MS} ms`,
        );
        f.expect(
          vad.params.startMs >= ms && vad.params.stopMs >= ms,
          `startMs/stopMs are shorter than one ${ms.toFixed(2)} ms frame`,
        );
      }
      return f.messages;
    },
  },
  {
    name: 'silence stays below and speech crosses the confidence threshold',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      for (const rate of RATES) {
        const analyzer = vad.create(rate);
        const quiet = confidences(f, analyzer, silencePcm16(1000, rate), `${rate} Hz silence`);
        f.expect(
          Math.max(...quiet) < vad.params.confidence,
          `${rate} Hz: silence reached ${Math.max(...quiet)}`,
        );
        analyzer.reset();
        const voiced = confidences(
          f,
          analyzer,
          speechLikePcm16({ seed: 7, ms: 1000, rate }),
          `${rate} Hz speech`,
        );
        f.expect(
          Math.max(...voiced) >= vad.params.confidence,
          `${rate} Hz: speech peaked at ${Math.max(...voiced)}`,
        );
      }
      return f.messages;
    },
  },
  {
    /** startMs and stopMs are the declared latency budget; they used to be inert (#F20). */
    name: 'confidence rises within startMs and falls back within stopMs',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      for (const rate of RATES) {
        const analyzer = vad.create(rate);
        analyzer.reset();
        const onset = confidences(
          f,
          analyzer,
          speechLikePcm16({ seed: 11, ms: vad.params.startMs, rate }),
          `${rate} Hz onset`,
        );
        f.expect(
          onset.at(-1)! >= vad.params.confidence,
          `${rate} Hz: after ${vad.params.startMs} ms of speech the confidence is only ${onset.at(-1)}`,
        );
        const tail = confidences(
          f,
          analyzer,
          silencePcm16(vad.params.stopMs, rate),
          `${rate} Hz tail`,
        );
        f.expect(
          tail.at(-1)! < vad.params.confidence,
          `${rate} Hz: ${vad.params.stopMs} ms after speech ended the confidence is still ${tail.at(-1)}`,
        );
        if (vad.params.smoothing > 0)
          f.expect(
            onset[0]! < Math.max(...onset),
            `${rate} Hz: smoothing ${vad.params.smoothing} is declared but the first frame already reached the peak`,
          );
      }
      return f.messages;
    },
  },
  {
    name: 'volume is normalised, discriminates level and spans minVolume',
    async run({ factory }) {
      const f = new Failures();
      const vad = await factory();
      const analyzer = vad.create(16000);
      const tone = (amplitude: number) => tonePcm16({ freq: 440, ms: 200, rate: 16000, amplitude });
      const loud = volumeOf(f, analyzer, tone(30000), 'near full scale');
      const quiet = volumeOf(f, analyzer, tone(300), 'very quiet');
      const silent = volumeOf(f, analyzer, silencePcm16(200, 16000), 'silence');
      f.expect(loud > quiet, `volume does not discriminate level: loud ${loud} vs quiet ${quiet}`);
      f.expect(
        loud >= vad.params.minVolume,
        `near-full-scale audio reports volume ${loud}, below the declared minVolume ${vad.params.minVolume}`,
      );
      f.expect(
        quiet < vad.params.minVolume,
        `very quiet audio reports volume ${quiet}, at or above minVolume ${vad.params.minVolume}`,
      );
      f.expect(silent <= 0.05, `silence reports volume ${silent}`);
      return f.messages;
    },
  },
  {
    name: 'analysis is deterministic after reset',
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
      return f.messages;
    },
  },
];
