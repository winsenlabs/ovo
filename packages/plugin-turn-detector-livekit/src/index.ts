import { inference, initializeLogger, InferenceRunner } from '@livekit/agents';
import { predict as predictLocal } from '@livekit/local-inference';
import { AudioFrame } from '@livekit/rtc-node';

/**
 * LiveKit's end-of-turn models, run through the LiveKit Agents framework OVO already depends on
 * (@livekit/agents 1.9.0, plugin-engine-livekit). Both are under the LiveKit Model License
 * (huggingface.co/livekit/turn-detector/blob/main/LICENSE, 2024-11-25): free to use, but "not ...
 * on a standalone basis or with any frameworks other than LiveKit Agents". So the models are only
 * ever reached through the framework's own classes: the audio model through
 * `inference.TurnDetector` (its stream buffers, resamples and thresholds the audio), the text model
 * through the runner LiveKit Agents registers for it. Whether OVO's native engine counts as
 * "together with LiveKit Agents" is for the founder (and counsel) to decide before production use;
 * docs/eval/turn-bakeoff.md has the options.
 *
 * - `turn-detector-v1-mini` (audio): LiveKit's current local detector, compiled into
 *   @livekit/local-inference 0.2.7 (~108 MB of weights inside the native binary; darwin-arm64,
 *   darwin-x64, linux-x64-gnu, linux-arm64-gnu builds). It reads the last 1.2 s of 16 kHz audio once
 *   200 ms of silence has passed; per-language thresholds (hi 0.305, en 0.36).
 * - `v0.4.1-intl` (text, deprecated by LiveKit in agents-plugin-livekit 1.9 in favour of the audio
 *   model): Qwen2.5-0.5B distilled, 396 MB int8 ONNX fetched from Hugging Face, reads the last turns
 *   of the conversation. Kept for the Wave 13 bake-off only: it is the one model that can score
 *   calls 4-6, which have no audio. Its packages (@livekit/agents-plugin-livekit, and through it
 *   @huggingface/transformers, sharp and onnxruntime-node 1.24) are dev dependencies: a production
 *   install has none of them, and `LiveKitTextModel.load` fails there.
 *
 * This package is a model runtime only (package kind `kit`): plugin-turns' model gate hosts it.
 */
export const LIVEKIT_AUDIO = Object.freeze({
  model: 'turn-detector-v1-mini',
  package: '@livekit/local-inference@0.2.7',
  /** The stream's ring buffer (transports.js CLIENT_BUFFER_SECONDS). */
  windowMs: 1200,
});
export const LIVEKIT_TEXT = Object.freeze({
  repo: 'livekit/turn-detector',
  revision: 'v0.4.1-intl',
  commit: '87e35fcb1e60a569bea70346191c4886ea92e281',
  file: 'onnx/model_q8.onnx',
  sha256: 'bd2c30776882138a1d95a07faddc13756fe1a35bef6323505f1124fca349bc9c',
  bytes: 396_316_457,
  method: 'lk_end_of_utterance_multilingual',
});

/** The request plugin-turns' model gate makes (structurally its EndOfTurnRequest). */
export interface EndOfTurnRequest {
  audio?: Int16Array;
  text: string;
  /** The agent's line before the caller's words (text model context). */
  agentText?: string;
  language: string;
}

let logger = false;
/** LiveKit Agents' logger must exist before any of its classes run. */
function ensureLogger(): void {
  if (logger) return;
  try {
    initializeLogger({ pretty: false, level: 'warn' });
  } catch {
    // Already initialised by the host (plugin-engine-livekit).
  }
  logger = true;
}

/** LiveKit Agents' inference executor (ipc/inference_executor.d.ts; not exported by the package). */
interface InferenceExecutor {
  doInference(method: string, data: unknown): Promise<unknown>;
}

const base = (language: string) => language.toLowerCase().split(/[-_]/)[0]!;
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The in-process inference executor: what LiveKit Agents' shared inference process does for the
 * local audio detector (EotRunner: decode the base64 PCM, `predict`, time it).
 */
class LocalEotExecutor implements InferenceExecutor {
  readonly timings: number[] = [];

  async doInference(method: string, data: unknown): Promise<unknown> {
    if (method !== 'lk_eot_audio') throw new Error(`no local runner for ${method}`);
    const bytes = Buffer.from((data as { pcm: string }).pcm, 'base64');
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const started = performance.now();
    const probability = await predictLocal(pcm);
    const inferenceDurationMs = performance.now() - started;
    this.timings.push(inferenceDurationMs);
    return { probability, inferenceDurationMs };
  }
}

export class LiveKitAudioModel {
  readonly name = 'livekit-turn-detector-v1-mini';
  readonly input = 'audio' as const;
  private readonly executor = new LocalEotExecutor();
  private readonly detector: InstanceType<typeof inference.TurnDetector>;
  private readonly stream: ReturnType<InstanceType<typeof inference.TurnDetector>['stream']>;

  constructor(options: { unlikelyThreshold?: number } = {}) {
    ensureLogger();
    this.detector = new inference.TurnDetector({
      version: 'v1-mini',
      executor: this.executor,
      ...(options.unlikelyThreshold === undefined
        ? {}
        : { unlikelyThreshold: options.unlikelyThreshold }),
    });
    this.stream = this.detector.stream();
  }

  /** Inference time of each prediction so far (ms). */
  get timings(): readonly number[] {
    return this.executor.timings;
  }

  threshold(language: string): number | undefined {
    const thresholds = this.detector.thresholds as Record<string, number>;
    return thresholds[base(language)];
  }

  /**
   * The detector's stream holds the last 1.2 s it was pushed: the turn's audio is pushed afresh
   * (after a flush) and the stream predicts on it, as AudioRecognition does once 200 ms of silence
   * has passed.
   */
  async predict(request: EndOfTurnRequest): Promise<number> {
    if (!request.audio?.length) throw new Error('turn-detector-v1-mini needs the caller audio');
    const samples = request.audio.subarray(
      Math.max(0, request.audio.length - (LIVEKIT_AUDIO.windowMs * 16_000) / 1000),
    );
    this.stream.flush();
    this.stream.pushAudio(new AudioFrame(Int16Array.from(samples), 16_000, 1, samples.length));
    // The stream drains its channel into the transport on its own task.
    await delay();
    await delay();
    const event = await this.stream.predict().await;
    return event.endOfTurnProbability;
  }

  async dispose(): Promise<void> {
    await this.stream.aclose();
    await this.detector.aclose();
  }
}

interface TextRunner {
  initialize(): Promise<void>;
  run(data: unknown): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * LiveKit's (deprecated) multilingual text detector, v0.4.1-intl, through the runner LiveKit Agents
 * registers for it and its `EOUModel` (history of up to 6 turns, per-language thresholds from the
 * model's languages.json). Its files must be in the Hugging Face caches (scripts/fetch-model.mjs).
 */
export class LiveKitTextModel {
  readonly name = 'livekit-turn-detector-v0.4.1-intl';
  readonly input = 'text' as const;
  private constructor(
    /** Inference time of each prediction so far (ms). */
    readonly timings: number[],
    private readonly runner: TextRunner,
    private readonly model: {
      predictEndOfTurn(chat: unknown): Promise<number>;
      unlikelyThreshold(language?: string): Promise<number | undefined>;
    },
    private readonly thresholds: Map<string, number | undefined>,
  ) {}

  static async load(languages: readonly string[] = ['en', 'hi']): Promise<LiveKitTextModel> {
    ensureLogger();
    const { turnDetector } = await import('@livekit/agents-plugin-livekit');
    const url = (InferenceRunner as unknown as { registeredRunners: Record<string, string> })
      .registeredRunners[LIVEKIT_TEXT.method];
    if (!url) throw new Error(`LiveKit Agents registered no runner for ${LIVEKIT_TEXT.method}`);
    const Runner = ((await import(url)) as { default: new () => TextRunner }).default;
    const runner = new Runner();
    await runner.initialize();
    const timings: number[] = [];
    const executor: InferenceExecutor = {
      doInference: async (_method, data) => {
        const started = performance.now();
        const result = await runner.run(data);
        timings.push(performance.now() - started);
        return result;
      },
    };
    class Multilingual extends turnDetector.EOUModel {
      inferenceMethod() {
        return LIVEKIT_TEXT.method;
      }
    }
    const model = new Multilingual({ modelType: 'multilingual', executor }) as never as {
      predictEndOfTurn(chat: unknown): Promise<number>;
      unlikelyThreshold(language?: string): Promise<number | undefined>;
    };
    const thresholds = new Map<string, number | undefined>();
    for (const language of languages)
      thresholds.set(base(language), await model.unlikelyThreshold(base(language)));
    timings.length = 0;
    return new LiveKitTextModel(timings, runner, model, thresholds);
  }

  threshold(language: string): number | undefined {
    return this.thresholds.get(base(language));
  }

  /** The chat as the model's `predictEndOfTurn` reads it: the agent's line, then the caller's. */
  async predict(request: EndOfTurnRequest): Promise<number> {
    const items = [
      ...(request.agentText ? [message('assistant', request.agentText)] : []),
      message('user', request.text),
    ];
    return this.model.predictEndOfTurn({ items });
  }

  async dispose(): Promise<void> {
    await this.runner.close();
  }
}

/** The shape EOUModel.predictEndOfTurn reads from a ChatContext item. */
function message(role: 'user' | 'assistant', text: string) {
  return { type: 'message', role, textContent: text };
}
