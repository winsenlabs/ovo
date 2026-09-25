import type { SecretResolver } from '@winsendotai/ovo-contracts';
import { abortError, decimal, withDeadline } from './abort.ts';
import { createMonoWav } from './audio.ts';
import {
  assertSuccessful,
  readBoundedJson,
  validateProviderEndpoint,
  type ProviderHttpDependencies,
} from './http.ts';
import {
  ProviderBufferError,
  ProviderProtocolError,
  immutableBinding,
  type BatchTranscriber,
  type BatchTranscriptionRequest,
  type BatchTranscriptionResult,
  type OpenAiBatchSttBinding,
  type ProviderUsage,
  type ProviderUsageSink,
} from './types.ts';

const OPENAI_TRANSCRIPTION_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export interface OpenAiBatchSttDependencies extends ProviderHttpDependencies {
  secrets: SecretResolver;
  usage?: ProviderUsageSink;
  /** Not plugin-configurable. Used by local protocol tests only. */
  endpoint?: string;
}

export class OpenAiBatchTranscriber implements BatchTranscriber {
  readonly binding: Readonly<OpenAiBatchSttBinding>;
  private readonly endpoint: URL;
  private readonly fetch: typeof globalThis.fetch;

  private constructor(
    binding: OpenAiBatchSttBinding,
    private readonly apiKey: string,
    private readonly usageSink: ProviderUsageSink | undefined,
    dependencies: ProviderHttpDependencies & { endpoint?: string },
  ) {
    this.binding = immutableBinding(binding);
    validateBinding(this.binding);
    this.endpoint = validateProviderEndpoint(
      dependencies.endpoint ?? OPENAI_TRANSCRIPTION_ENDPOINT,
      '/v1/audio/transcriptions',
      dependencies.allowPrivateTestEndpoint,
    );
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  static async create(
    binding: OpenAiBatchSttBinding,
    dependencies: OpenAiBatchSttDependencies,
  ): Promise<OpenAiBatchTranscriber> {
    const snapshot = immutableBinding(binding);
    const apiKey = await dependencies.secrets.resolve(snapshot.workspaceId, snapshot.credentialId);
    return new OpenAiBatchTranscriber(snapshot, apiKey, dependencies.usage, dependencies);
  }

  async transcribe(request: BatchTranscriptionRequest): Promise<BatchTranscriptionResult> {
    if (request.signal.aborted) throw abortError(request.signal);
    if (request.audio.byteLength > this.binding.maxAudioBytes)
      throw new ProviderBufferError('Batch transcription audio exceeded the configured byte limit');
    if (request.codec === 'audio/x-mulaw' && request.sampleRate !== 8_000)
      throw new TypeError('G.711 mu-law transcription input must be 8 kHz');
    const startedAt = performance.now();
    const deadline = withDeadline(
      request.signal,
      this.binding.requestTimeoutMs,
      'OpenAI transcription deadline exceeded',
    );
    try {
      const form = new FormData();
      const wav = createMonoWav(request.audio, request.codec, request.sampleRate);
      form.set('file', new Blob([new Uint8Array(wav).buffer], { type: 'audio/wav' }), 'audio.wav');
      form.set('model', this.binding.model);
      form.set('response_format', 'json');
      if (this.binding.language) form.set('language', this.binding.language);
      const response = await this.fetch(this.endpoint, {
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
      const usage = parseUsage(body.usage, requestId, performance.now() - startedAt);
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
  for (const field of ['requestTimeoutMs', 'maxAudioBytes', 'maxResponseBytes'] as const)
    if (!Number.isSafeInteger(binding[field]) || binding[field] < 1)
      throw new TypeError(`${field} must be a positive integer`);
}
