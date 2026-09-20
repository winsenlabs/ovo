export const PROVIDER_SERVICE_KEYS = Object.freeze({
  secretResolver: 'ovo.secret-resolver',
  inference: 'ovo.inference',
  streamingStt: 'ovo.stt',
  batchStt: 'ovo.stt-batch',
  streamingTts: 'ovo.tts-streaming',
  cachedTts: 'ovo.tts',
  media: 'ovo.media.duplex',
  speechOutput: 'ovo.speech-output',
});

export const PROVIDER_PLUGIN_IDS = Object.freeze({
  deepgramStt: '@winsendotai/ovo-provider-deepgram-stt',
  openAiTts: '@winsendotai/ovo-provider-openai-tts',
  openAiBatchStt: '@winsendotai/ovo-provider-openai-batch-stt',
  openAiInference: '@winsendotai/ovo-provider-openai-inference',
});

export interface ProviderBindingBase {
  workspaceId: string;
  bindingVersion: string;
  credentialId: string;
  model: string;
}

export interface DeepgramBinding extends ProviderBindingBase {
  language?: string;
  endpointingMs: number;
  utteranceEndMs?: number;
  connectAttempts: number;
  connectTimeoutMs: number;
  finishTimeoutMs: number;
  maxSessionMs: number;
  keepAliveMs: number;
  maxInputChunkBytes: number;
  maxBufferedBytes: number;
  maxMessageBytes: number;
}

export interface OpenAiTtsBinding extends ProviderBindingBase {
  voice: string;
  instructions?: string;
  speed: number;
  requestTimeoutMs: number;
  maxInputCharacters: number;
  maxResponseBytes: number;
  maxOutputChunkBytes: number;
}

export interface OpenAiBatchSttBinding extends ProviderBindingBase {
  language?: string;
  requestTimeoutMs: number;
  maxAudioBytes: number;
  maxResponseBytes: number;
}

export interface OpenAiInferenceBinding extends ProviderBindingBase {
  api: 'responses' | 'chat';
}

interface UsageBase {
  provider: 'deepgram' | 'openai';
  operation: 'streaming-stt' | 'streaming-tts' | 'batch-stt';
  requestId?: string;
  elapsedMs: number;
}

export type ProviderUsage =
  | (UsageBase & {
      quantity: string;
      unit: 'audio_seconds' | 'characters' | 'input_tokens' | 'output_tokens' | 'total_tokens';
      state: 'estimated' | 'reconciled';
      missing?: never;
    })
  | (UsageBase & {
      quantity?: never;
      unit: 'audio_seconds' | 'tokens';
      state: 'unavailable';
      missing: 'provider-omitted';
    });

export type ProviderUsageSink = (usage: ProviderUsage) => void;

export interface BatchTranscriptionRequest {
  audio: Uint8Array;
  codec: 'audio/x-mulaw' | 'audio/pcm';
  sampleRate: 8_000 | 24_000;
  signal: AbortSignal;
}

export interface BatchTranscriptionResult {
  text: string;
  durationSeconds?: number;
  requestId?: string;
  usage?: ProviderUsage;
}

/** Batch-only capability. It must never be registered as ovo.stt. */
export interface BatchTranscriber {
  transcribe(request: BatchTranscriptionRequest): Promise<BatchTranscriptionResult>;
}

export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}

export class ProviderBufferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderBufferError';
  }
}

export function immutableBinding<T extends ProviderBindingBase>(binding: T): Readonly<T> {
  validateBindingBase(binding);
  return Object.freeze(structuredClone(binding));
}

function validateBindingBase(binding: ProviderBindingBase): void {
  for (const field of ['workspaceId', 'bindingVersion', 'credentialId', 'model'] as const) {
    if (!binding[field]?.trim()) throw new TypeError(`${field} must not be empty`);
  }
}
