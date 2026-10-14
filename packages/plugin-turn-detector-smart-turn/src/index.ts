import { InferenceSession, Tensor } from 'onnxruntime-node';
import { lastWindow, logMel, N_FRAMES, N_MELS } from './features.ts';

export { lastWindow, logMel, N_FRAMES, N_MELS, SAMPLE_RATE, WINDOW_SAMPLES } from './features.ts';

/**
 * Pipecat Smart Turn v3.2 (BSD-2-Clause, github.com/pipecat-ai/smart-turn): an audio end-of-turn
 * model, Whisper Tiny's encoder with a linear head (8 MB int8 ONNX for CPU). It reads the caller's
 * current turn as 16 kHz audio (the last 8 s) and returns the probability the turn is complete.
 * 23 languages, Hindi among them (benchmarks/smart-turn-v3.2-cpu.md: 90.1% on Hindi, 94.3% on
 * English). The file is fetched at build time (scripts/fetch-model.mjs, pinned revision and SHA-256).
 *
 * This package is a model runtime only (package kind `kit`): plugin-turns' model gate hosts it
 * behind the turn-detector interface (`createModelTurnDetector`), the rules detector doing the rest.
 */
export const SMART_TURN = Object.freeze({
  repo: 'pipecat-ai/smart-turn-v3',
  revision: 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93',
  file: 'smart-turn-v3.2-cpu.onnx',
  sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f',
  bytes: 8_679_182,
  /** inference.py: `prediction = 1 if probability > 0.5`. */
  threshold: 0.5,
  /** The languages the v3.2 benchmark covers (ISO 639-1). */
  languages: Object.freeze([
    'ar',
    'bn',
    'da',
    'de',
    'en',
    'es',
    'fi',
    'fr',
    'hi',
    'id',
    'it',
    'ja',
    'ko',
    'mr',
    'nl',
    'no',
    'pl',
    'pt',
    'ru',
    'tr',
    'uk',
    'vi',
    'zh',
  ]),
});

/** The request plugin-turns' model gate makes (structurally its EndOfTurnRequest). */
export interface EndOfTurnRequest {
  /** The caller's current turn, 16 kHz mono, newest sample last. */
  audio?: Int16Array;
  text: string;
  language: string;
}

export interface SmartTurnOptions {
  /** Path to smart-turn-v3.2-cpu.onnx. */
  modelPath: string;
  /** Probability at or above which the turn is complete (default 0.5, the reference's). */
  threshold?: number;
  /** ONNX Runtime intra-op threads (default 1: one call's endpointing never takes the worker's cores). */
  threads?: number;
}

export class SmartTurnModel {
  readonly name = 'smart-turn-v3.2';
  readonly input = 'audio' as const;
  /** Wall-clock milliseconds of each prediction so far (features + inference), for reports. */
  readonly timings: number[] = [];

  private constructor(
    private readonly session: InferenceSession,
    private readonly cutoff: number,
  ) {}

  static async load(options: SmartTurnOptions): Promise<SmartTurnModel> {
    // As the reference inference.py: sequential execution, one inter-op thread, all optimisations.
    const session = await InferenceSession.create(options.modelPath, {
      executionMode: 'sequential',
      interOpNumThreads: 1,
      intraOpNumThreads: options.threads ?? 1,
      graphOptimizationLevel: 'all',
    });
    return new SmartTurnModel(session, options.threshold ?? SMART_TURN.threshold);
  }

  threshold(language: string): number | undefined {
    const base = language.toLowerCase().split(/[-_]/)[0]!;
    return SMART_TURN.languages.includes(base) ? this.cutoff : undefined;
  }

  /** The probability that the turn whose audio ends `request.audio` is complete. */
  async predict(request: EndOfTurnRequest): Promise<number> {
    if (!request.audio?.length) throw new Error('Smart Turn needs the caller audio');
    return this.probability(request.audio);
  }

  async probability(pcm16k: Int16Array): Promise<number> {
    const started = performance.now();
    const features = logMel(lastWindow(pcm16k));
    const input = new Tensor('float32', features, [1, N_MELS, N_FRAMES]);
    const outputs = await this.session.run({ input_features: input });
    const output = outputs[this.session.outputNames[0]!]!;
    this.timings.push(performance.now() - started);
    return Number((output.data as Float32Array)[0]);
  }

  async dispose(): Promise<void> {
    await this.session.release();
  }
}
