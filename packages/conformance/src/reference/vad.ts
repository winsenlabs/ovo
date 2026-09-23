import {
  DEFAULT_VAD_PARAMS,
  VadParamsSchema,
  type VadAnalyzer,
  type VadAnalyzerFactory,
  type VadParams,
} from '@winsendotai/ovo-contracts';

/** RMS of a PCM16 frame as a fraction of full scale. */
function rms(pcm: Int16Array): number {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const sample of pcm) sum += sample * sample;
  return Math.sqrt(sum / pcm.length) / 32768;
}

/**
 * The in-kit reference VAD: 20 ms frames, confidence is a logistic of the frame's level in dBFS
 * (−45 dBFS ↦ 0.5), smoothed exponentially. Deterministic for a given input.
 */
export function createReferenceVad(params: Partial<VadParams> = {}): VadAnalyzerFactory {
  const resolved = VadParamsSchema.parse({ ...DEFAULT_VAD_PARAMS, ...params });
  return {
    params: resolved,
    create(rate): VadAnalyzer {
      if (rate !== 8000 && rate !== 16000)
        throw new RangeError('reference VAD supports 8 kHz and 16 kHz');
      let smoothed = 0;
      return {
        frameSamples: rate / 50,
        sampleRate: rate,
        confidence(pcm) {
          if (pcm.length !== rate / 50)
            throw new RangeError(`expected ${rate / 50} samples per frame`);
          const level = rms(pcm);
          const db = level === 0 ? -120 : 20 * Math.log10(level);
          const raw = 1 / (1 + Math.exp(-(db + 45) / 3));
          smoothed = resolved.smoothing * smoothed + (1 - resolved.smoothing) * raw;
          return smoothed;
        },
        volume(pcm) {
          return Math.min(1, rms(pcm) * 4);
        },
        reset() {
          smoothed = 0;
        },
      };
    },
  };
}
