import { z } from 'zod';

/** VAD tuning (§2.7). The schema carries the documented defaults. */
export const VadParamsSchema = z
  .object({
    confidence: z.number().min(0).max(1).default(0.7),
    startMs: z.number().int().min(0).max(5000).default(200),
    stopMs: z.number().int().min(0).max(5000).default(200),
    minVolume: z.number().min(0).max(1).default(0.6),
    smoothing: z.number().min(0).max(1).default(0.2),
  })
  .strict();
export type VadParams = z.output<typeof VadParamsSchema>;
export const DEFAULT_VAD_PARAMS: VadParams = Object.freeze(VadParamsSchema.parse({}));

export interface VadAnalyzer {
  readonly frameSamples: number;
  readonly sampleRate: 8000 | 16000;
  confidence(pcm: Int16Array): number;
  volume(pcm: Int16Array): number;
  reset(): void;
}

export interface VadAnalyzerFactory {
  readonly params: VadParams;
  create(rate: 8000 | 16000): VadAnalyzer;
}
