import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { WINDOW_SAMPLES } from './features.ts';
import type { SmartTurnReply, SmartTurnRequest, SmartTurnWorkerData } from './inference-worker.ts';

export { lastWindow, logMel, N_FRAMES, N_MELS, SAMPLE_RATE, WINDOW_SAMPLES } from './features.ts';

/**
 * Pipecat Smart Turn v3.2 (BSD-2-Clause, github.com/pipecat-ai/smart-turn): an audio end-of-turn
 * model, Whisper Tiny's encoder with a linear head (8 MB int8 ONNX for CPU). It reads the caller's
 * current turn as 16 kHz audio (the last 8 s) and returns the probability the turn is complete.
 * 23 languages, Hindi among them (benchmarks/smart-turn-v3.2-cpu.md: 90.1% on Hindi, 94.3% on
 * English). The file is fetched at build time (scripts/fetch-model.mjs, pinned revision and SHA-256).
 * Readings run on a worker thread of their own (inference-worker.ts), never on the event loop.
 *
 * This package is a model runtime only (package kind `host`, not `kit`: kits may not import node
 * built-ins, and it runs a worker thread): plugin-turns' model gate hosts it behind the
 * turn-detector interface (`createModelTurnDetector`), the rules detector doing the rest.
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
  /**
   * Readings waiting on the worker thread past which a new one fails at once (default 8): the model
   * gate then ends the turn as the rules did, instead of waiting behind other calls' readings.
   */
  maxPending?: number;
  /**
   * The worker thread's entry (default: inference-worker.ts beside this file). A host that bundles
   * this package builds inference-worker.ts as an entry of its own and passes its URL.
   */
  workerUrl?: URL;
}

const exited = (code: number) => new Error(`Smart Turn's worker thread exited (${code})`);

export class SmartTurnModel {
  readonly name = 'smart-turn-v3.2';
  readonly input = 'audio' as const;
  /** Milliseconds of each prediction so far (features + inference, on the worker thread). */
  readonly timings: number[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (probability: number) => void; reject: (error: Error) => void }
  >();
  private sequence = 0;
  /** Set once the worker thread has died: every reading fails from then on. */
  private dead?: Error;

  private constructor(
    private readonly worker: Worker,
    private readonly cutoff: number,
    private readonly maxPending: number,
  ) {
    worker.on('message', (reply: SmartTurnReply) => this.settle(reply));
    worker.on('error', (error) => this.fail(error));
    worker.on('exit', (code) => this.fail(exited(code)));
  }

  static async load(options: SmartTurnOptions): Promise<SmartTurnModel> {
    const data: SmartTurnWorkerData = {
      modelPath: options.modelPath,
      threads: options.threads ?? 1,
    };
    const worker = new Worker(
      options.workerUrl ?? new URL('./inference-worker.ts', import.meta.url),
      {
        workerData: data,
      },
    );
    try {
      // The thread says it is ready once the model is loaded; a failed load is its 'error'.
      await once(worker, 'message');
    } catch (error) {
      await worker.terminate();
      throw error;
    }
    // Idle, the thread does not keep the process alive; a reading waited on does (probability).
    worker.unref();
    return new SmartTurnModel(
      worker,
      options.threshold ?? SMART_TURN.threshold,
      options.maxPending ?? 8,
    );
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
    if (this.dead) throw this.dead;
    if (this.pending.size >= this.maxPending)
      throw new Error(`Smart Turn: ${this.pending.size} readings already waiting`);
    // The window the model reads, copied so its buffer can move to the worker thread.
    const pcm = pcm16k.slice(Math.max(0, pcm16k.length - WINDOW_SAMPLES));
    const request: SmartTurnRequest = { id: ++this.sequence, pcm };
    return new Promise<number>((resolve, reject) => {
      if (!this.pending.size) this.worker.ref();
      this.pending.set(request.id, { resolve, reject });
      this.worker.postMessage(request, [pcm.buffer]);
    });
  }

  async dispose(): Promise<void> {
    this.fail(new Error('Smart Turn was disposed'));
    await this.worker.terminate();
  }

  private settle(reply: SmartTurnReply): void {
    const waiting = this.pending.get(reply.id);
    if (!waiting) return;
    this.pending.delete(reply.id);
    if (!this.pending.size) this.worker.unref();
    if ('error' in reply) return waiting.reject(new Error(reply.error));
    this.timings.push(reply.ms);
    waiting.resolve(reply.probability);
  }

  private fail(error: Error): void {
    this.dead ??= error;
    for (const waiting of this.pending.values()) waiting.reject(this.dead);
    this.pending.clear();
  }
}
