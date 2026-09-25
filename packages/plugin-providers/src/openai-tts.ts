import type { SecretResolver } from '@winsendotai/ovo-contracts';
import type {
  NormalizedTts,
  TtsSynthesisRequest,
  TtsSynthesisResult,
} from '@winsendotai/ovo-plugin-speech-cache';
import type { StreamingTts } from '@winsendotai/ovo-plugin-voice';
import { abortError, decimal, withDeadline } from './abort.ts';
import { OpenAiPcmConverter } from './audio.ts';
import {
  assertSuccessful,
  validateProviderEndpoint,
  type ProviderHttpDependencies,
} from './http.ts';
import {
  ProviderProtocolError,
  immutableBinding,
  type OpenAiTtsBinding,
  type ProviderUsage,
  type ProviderUsageSink,
} from './types.ts';

const OPENAI_SPEECH_ENDPOINT = 'https://api.openai.com/v1/audio/speech';

export interface OpenAiTtsDependencies extends ProviderHttpDependencies {
  secrets: SecretResolver;
  usage?: ProviderUsageSink;
  /** Not plugin-configurable. Used by local protocol tests only. */
  endpoint?: string;
}

export interface TtsStream {
  audio: AsyncIterable<Uint8Array>;
  completed: Promise<{ requestId?: string; usage: ProviderUsage }>;
}

interface OpenAiTtsStreamRequest {
  sessionId?: string;
  text: string;
  codec: 'audio/x-mulaw' | 'audio/pcm';
  sampleRate: 8_000 | 24_000;
  voice?: string;
  signal: AbortSignal;
}

type LiveTtsRequest = Parameters<StreamingTts['synthesize']>[0];

export class OpenAiStreamingTts implements StreamingTts {
  readonly binding: Readonly<OpenAiTtsBinding>;
  private readonly endpoint: URL;
  private readonly fetch: typeof globalThis.fetch;

  private constructor(
    binding: OpenAiTtsBinding,
    private readonly apiKey: string,
    private readonly usageSink: ProviderUsageSink | undefined,
    dependencies: ProviderHttpDependencies & { endpoint?: string },
  ) {
    this.binding = immutableBinding(binding);
    validateTtsBinding(this.binding);
    this.endpoint = validateProviderEndpoint(
      dependencies.endpoint ?? OPENAI_SPEECH_ENDPOINT,
      '/v1/audio/speech',
      dependencies.allowPrivateTestEndpoint,
    );
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  static async create(
    binding: OpenAiTtsBinding,
    dependencies: OpenAiTtsDependencies,
  ): Promise<OpenAiStreamingTts> {
    const snapshot = immutableBinding(binding);
    const apiKey = await dependencies.secrets.resolve(snapshot.workspaceId, snapshot.credentialId);
    return new OpenAiStreamingTts(snapshot, apiKey, dependencies.usage, dependencies);
  }

  synthesize(request: LiveTtsRequest): AsyncIterable<Uint8Array> {
    return this.stream(request).audio;
  }

  stream(request: OpenAiTtsStreamRequest): TtsStream {
    const completion = deferred<{ requestId?: string; usage: ProviderUsage }>();
    const audio = this.generate(request, completion);
    void completion.promise.catch(() => undefined);
    return { audio, completed: completion.promise };
  }

  private async *generate(
    request: OpenAiTtsStreamRequest,
    completion: Deferred<{ requestId?: string; usage: ProviderUsage }>,
  ): AsyncGenerator<Uint8Array> {
    const startedAt = performance.now();
    const deadline = withDeadline(
      request.signal,
      this.binding.requestTimeoutMs,
      'OpenAI TTS deadline exceeded',
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      validateTtsRequest(request, this.binding);
      if (deadline.signal.aborted) throw abortError(deadline.signal);
      const response = await this.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.binding.model,
          voice: this.binding.voice,
          input: request.text,
          instructions: this.binding.instructions,
          speed: this.binding.speed,
          response_format: 'pcm',
        }),
        signal: deadline.signal,
      });
      await assertSuccessful(response);
      if (!response.body) throw new ProviderProtocolError('OpenAI TTS response has no body');
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const converter = new OpenAiPcmConverter(
        request.codec,
        request.sampleRate,
        this.binding.maxOutputChunkBytes,
      );
      reader = response.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > this.binding.maxResponseBytes)
          throw new ProviderProtocolError('OpenAI TTS response exceeded the configured byte limit');
        for (const chunk of converter.push(value)) yield chunk;
      }
      for (const chunk of converter.finish()) yield chunk;
      const usage: ProviderUsage = {
        provider: 'openai',
        operation: 'streaming-tts',
        requestId,
        quantity: decimal([...request.text].length),
        unit: 'characters',
        state: 'estimated',
        elapsedMs: performance.now() - startedAt,
      };
      this.usageSink?.(usage);
      completion.resolve({ requestId, usage });
    } catch (error) {
      const failure = deadline.signal.aborted ? abortError(deadline.signal) : error;
      completion.reject(failure);
      throw failure;
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      deadline.dispose();
      if (!completion.settled())
        completion.reject(
          new DOMException('TTS stream consumer stopped before completion', 'AbortError'),
        );
    }
  }
}

export class OpenAiCachedTtsBridge implements NormalizedTts {
  constructor(private readonly streaming: OpenAiStreamingTts) {}

  async synthesize(
    request: TtsSynthesisRequest,
    options: { signal: AbortSignal },
  ): Promise<TtsSynthesisResult> {
    if (
      request.model !== this.streaming.binding.model ||
      request.voice !== this.streaming.binding.voice
    )
      throw new TypeError('TTS request does not match the immutable provider binding');
    if (request.codec !== 'audio/x-mulaw' && request.codec !== 'audio/pcm')
      throw new TypeError('Unsupported TTS codec');
    if (request.sampleRate !== 8_000 && request.sampleRate !== 24_000)
      throw new TypeError('Unsupported TTS sample rate');
    const stream = this.streaming.stream({
      text: request.text,
      codec: request.codec,
      sampleRate: request.sampleRate,
      signal: options.signal,
    });
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream.audio) {
      total += chunk.byteLength;
      if (total > this.streaming.binding.maxResponseBytes)
        throw new ProviderProtocolError('Normalized TTS audio exceeded the configured byte limit');
      chunks.push(chunk);
    }
    const completed = await stream.completed;
    const audio = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      audio,
      usage: {
        provider: 'openai',
        unit: 'characters',
        quantity: decimal([...request.text].length),
        state: 'estimated',
        requestId: completed.requestId ?? 'provider-omitted',
      },
    };
  }
}

function validateTtsBinding(binding: Readonly<OpenAiTtsBinding>): void {
  if (!binding.voice.trim()) throw new TypeError('voice must not be empty');
  if (binding.speed < 0.25 || binding.speed > 4)
    throw new TypeError('speed must be between 0.25 and 4');
  for (const field of [
    'requestTimeoutMs',
    'maxInputCharacters',
    'maxResponseBytes',
    'maxOutputChunkBytes',
  ] as const)
    if (!Number.isSafeInteger(binding[field]) || binding[field] < 1)
      throw new TypeError(`${field} must be a positive integer`);
}

function validateTtsRequest(
  request: OpenAiTtsStreamRequest,
  binding: Readonly<OpenAiTtsBinding>,
): void {
  const characters = [...request.text].length;
  if (characters < 1 || characters > binding.maxInputCharacters)
    throw new TypeError(`TTS text must contain 1-${binding.maxInputCharacters} characters`);
  if (request.sampleRate !== 8_000 && request.sampleRate !== 24_000)
    throw new TypeError('TTS supports only 8 kHz or 24 kHz output');
  if (request.voice && request.voice !== binding.voice)
    throw new TypeError('TTS request voice does not match the immutable provider binding');
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled(): boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      settled = true;
      res(value);
    };
    reject = (reason) => {
      settled = true;
      rej(reason);
    };
  });
  return { promise, resolve, reject, settled: () => settled };
}
