import type { Clock, NetPort, SecretResolver } from '@winsendotai/ovo-contracts';
import {
  assertSuccessful,
  abortError,
  decimal,
  readBoundedJson,
  validateProviderEndpoint,
  ProviderProtocolError,
  systemClock,
  withDeadline,
} from '@winsendotai/ovo-plugin-kit';
import { createMonoWav } from './batch-wav.ts';

export interface OpenAiBatchSttBinding {
  workspaceId: string;
  bindingVersion: string;
  credentialId: string;
  model: string;
  language?: string;
  requestTimeoutMs: number;
  maxAudioBytes: number;
  maxResponseBytes: number;
}

export interface BatchTranscriptionRequest {
  audio: Uint8Array;
  codec: 'audio/x-mulaw' | 'audio/pcm';
  sampleRate: 8000 | 24000;
  signal: AbortSignal;
}

export type ProviderUsage =
  | {
      provider: 'openai';
      operation: 'batch-stt';
      requestId?: string;
      elapsedMs: number;
      quantity: string;
      unit: 'audio_seconds' | 'total_tokens';
      state: 'reconciled';
    }
  | {
      provider: 'openai';
      operation: 'batch-stt';
      requestId?: string;
      elapsedMs: number;
      unit: 'tokens';
      state: 'unavailable';
      missing: 'provider-omitted';
    };

export interface BatchTranscriptionResult {
  text: string;
  durationSeconds?: number;
  requestId?: string;
  usage: ProviderUsage;
}

export interface BatchTranscriber {
  transcribe(request: BatchTranscriptionRequest): Promise<BatchTranscriptionResult>;
}

export class ProviderBufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderBufferError';
  }
}

export interface OpenAiBatchSttDependencies {
  secrets: SecretResolver;
  usage?: (usage: ProviderUsage) => void;
  net: Pick<NetPort, 'fetch'>;
  clock?: Clock;
  endpoint?: string;
  allowPrivateTestEndpoint?: boolean;
}

const OPENAI_TRANSCRIPTION_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export class OpenAiBatchTranscriber implements BatchTranscriber {
  readonly binding: Readonly<OpenAiBatchSttBinding>;
  private readonly endpoint: URL;
  private readonly fetch: NetPort['fetch'];
  private readonly clock: Clock;

  private constructor(
    binding: OpenAiBatchSttBinding,
    private readonly apiKey: string,
    private readonly usageSink: ((usage: ProviderUsage) => void) | undefined,
    dependencies: OpenAiBatchSttDependencies,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    validateBinding(this.binding);
    this.endpoint = validateProviderEndpoint(
      dependencies.endpoint ?? OPENAI_TRANSCRIPTION_ENDPOINT,
      '/v1/audio/transcriptions',
      'api.openai.com',
      dependencies.allowPrivateTestEndpoint,
    );
    this.fetch = dependencies.net.fetch;
    this.clock = dependencies.clock ?? systemClock;
  }

  static async create(
    binding: OpenAiBatchSttBinding,
    dependencies: OpenAiBatchSttDependencies,
  ): Promise<OpenAiBatchTranscriber> {
    const snapshot = Object.freeze(structuredClone(binding));
    const apiKey = await dependencies.secrets.resolve(snapshot.workspaceId, snapshot.credentialId);
    return new OpenAiBatchTranscriber(snapshot, apiKey, dependencies.usage, dependencies);
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<BatchTranscriptionResult> {
    if (request.signal.aborted) throw abortError(request.signal);
    if (request.audio.byteLength > this.binding.maxAudioBytes)
      throw new ProviderBufferError('Batch transcription audio exceeded the configured byte limit');
    if (request.codec === 'audio/x-mulaw' && request.sampleRate !== 8_000)
      throw new TypeError('G.711 mu-law transcription input must be 8 kHz');
    const startedAt = this.clock.now();
    const deadline = withDeadline(
      request.signal,
      this.binding.requestTimeoutMs,
      'OpenAI transcription deadline exceeded',
      this.clock,
    );
    try {
      const form = new FormData();
      const wav = createMonoWav(request.audio, request.codec, request.sampleRate);
      form.set('file', new Blob([new Uint8Array(wav).buffer], { type: 'audio/wav' }), 'audio.wav');
      form.set('model', this.binding.model);
      form.set('response_format', 'json');
      if (this.binding.language) form.set('language', this.binding.language);
      const response = await this.fetch(this.endpoint.href, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: deadline.signal,
      });
      await assertSuccessful(response);
      const body = await readBoundedJson(response, this.binding.maxResponseBytes);
      if (typeof body.text !== 'string')
        throw new ProviderProtocolError('OpenAI transcription response omitted text');
      const requestId = response.headers.get('x-request-id') ?? undefined;
      const usage = parseUsage(body.usage, requestId, this.clock.now() - startedAt);
      this.usageSink?.(usage);
      return {
        text: body.text,
        durationSeconds: finiteNonnegative(body.duration),
        requestId,
        usage,
      };
    } catch (error) {
      throw deadline.signal.aborted ? abortError(deadline.signal) : error;
    } finally {
      deadline.dispose();
    }
  }
}

function parseUsage(
  value: unknown,
  requestId: string | undefined,
  elapsedMs: number,
): ProviderUsage {
  if (value && typeof value === 'object') {
    const usage = value as Record<string, unknown>;
    const seconds = finiteNonnegative(usage.seconds);
    if (seconds !== undefined)
      return {
        provider: 'openai',
        operation: 'batch-stt',
        requestId,
        quantity: decimal(seconds),
        unit: 'audio_seconds',
        state: 'reconciled',
        elapsedMs,
      };
    const totalTokens = finiteNonnegative(usage.total_tokens);
    if (totalTokens !== undefined)
      return {
        provider: 'openai',
        operation: 'batch-stt',
        requestId,
        quantity: decimal(totalTokens),
        unit: 'total_tokens',
        state: 'reconciled',
        elapsedMs,
      };
  }
  return {
    provider: 'openai',
    operation: 'batch-stt',
    requestId,
    state: 'unavailable',
    unit: 'tokens',
    missing: 'provider-omitted',
    elapsedMs,
  };
}

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function validateBinding(binding: Readonly<OpenAiBatchSttBinding>): void {
  for (const field of ['workspaceId', 'bindingVersion', 'credentialId', 'model'] as const)
    if (!binding[field]?.trim()) throw new TypeError(`${field} must not be empty`);
  for (const field of ['requestTimeoutMs', 'maxAudioBytes', 'maxResponseBytes'] as const)
    if (!Number.isSafeInteger(binding[field]) || binding[field] < 1)
      throw new TypeError(`${field} must be a positive integer`);
}
