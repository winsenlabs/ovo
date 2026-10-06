import {
  MULAW_8K,
  PCM16_16K,
  PCM16_8K,
  sameFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { createLogger, errorFields, systemClock } from '@winsendotai/ovo-plugin-kit';
import { connectTurnDetection, type EndpointingPreset } from './endpointing.ts';
import { callKeyterms, type AssemblyAiCallKeyterms, type KeytermStart } from './keyterms.ts';
import {
  MODEL_LANGUAGES,
  assemblyAiLanguageCodes,
  assemblyAiLanguages,
  assemblyAiSupportsLanguage,
  modelOf,
  proModel,
} from './languages.ts';
import { AssemblyAiProviderError, AssemblyAiSession } from './session.ts';

const logger = createLogger({ service: 'stt-assemblyai' });

export const ASSEMBLYAI_MODELS = [
  'universal-streaming-english',
  'universal-streaming-multilingual',
  'universal-3-5-pro',
  'universal-3-6-pro',
] as const;
export type AssemblyAiModel = (typeof ASSEMBLYAI_MODELS)[number];
export type AssemblyAiRegion = 'default' | 'us' | 'eu';

export interface AssemblyAiBinding {
  model?: AssemblyAiModel;
  region?: AssemblyAiRegion;
  /** A second region tried once when the first handshake times out or fails retryably. */
  fallbackRegion?: AssemblyAiRegion;
  /** Deadline for the socket open and Begin; defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /** A provider turn-detection preset; the explicit fields below override its values. */
  endpointing?: EndpointingPreset;
  minTurnSilenceMs?: number;
  maxTurnSilenceMs?: number;
  endOfTurnConfidenceThreshold?: number;
  /** Speech/non-speech threshold of the provider's own VAD (0 to 1). */
  vadThreshold?: number;
  keyterms?: readonly string[];
  /** Transcription instructions; sent to the pro models only. */
  prompt?: string;
  /**
   * Seconds without audio after which the provider ends the session (5 to 3600). Unset, there is
   * no inactivity timeout and the session is billed by its duration, which is why the worker does
   * not open one while an outbound call rings (STT-7;
   * https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api, retrieved
   * 2026-10-06).
   */
  inactivityTimeoutSec?: number;
}

/**
 * The live AssemblyAI handshake took 2-5s from asia-south1, so the deadline sits above it. Two
 * attempts fit the worker's fifteen-second pre-session audio buffer, so a slow handshake costs a
 * retry rather than the call.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 6_000;

export const ASSEMBLYAI_CAPABILITIES = Object.freeze({
  inputFormats: [MULAW_8K, PCM16_16K, PCM16_8K],
  frameMs: { min: 50, max: 1000, preferred: 100 },
  // Host compat compares the full release language; en-IN is AgentConfig's default.
  languages: ['en', 'en-IN'],
  // Base language codes per binding model, for a host compat check that reads the binding.
  bindingLanguages: { field: 'model', default: 'universal-streaming-english', by: MODEL_LANGUAGES },
  interim: true,
  wordTimestamps: true,
  turnSignals: ['speech-start', 'end-of-turn'] as const,
  forceEndpoint: true,
  ttfsP99Ms: 420,
});

/** The binding-aware capability set; the manifest's languages are the default model's. */
export function assemblyAiCapabilitiesFor(binding: Pick<AssemblyAiBinding, 'model'>) {
  return { ...ASSEMBLYAI_CAPABILITIES, languages: assemblyAiLanguages(binding) };
}

export function assemblyAiUrl(
  binding: AssemblyAiBinding,
  format: Parameters<SpeechToText['start']>[0]['format'],
  language?: string,
): string {
  const host =
    binding.region === 'us'
      ? 'streaming.us.assemblyai.com'
      : binding.region === 'eu'
        ? 'streaming.eu.assemblyai.com'
        : 'streaming.assemblyai.com';
  const url = new URL(`wss://${host}/v3/ws`);
  url.searchParams.set('speech_model', modelOf(binding));
  url.searchParams.set('sample_rate', String(format.sampleRate));
  url.searchParams.set('encoding', format.encoding === 'mulaw' ? 'pcm_mulaw' : 'pcm_s16le');
  url.searchParams.set('format_turns', 'false');
  const turns = connectTurnDetection(binding);
  if (turns.minTurnSilenceMs !== undefined)
    url.searchParams.set('min_turn_silence', String(turns.minTurnSilenceMs));
  if (turns.maxTurnSilenceMs !== undefined)
    url.searchParams.set('max_turn_silence', String(turns.maxTurnSilenceMs));
  if (turns.endOfTurnConfidenceThreshold !== undefined)
    url.searchParams.set(
      'end_of_turn_confidence_threshold',
      String(turns.endOfTurnConfidenceThreshold),
    );
  if (binding.vadThreshold !== undefined)
    url.searchParams.set('vad_threshold', String(binding.vadThreshold));
  if (binding.inactivityTimeoutSec !== undefined)
    url.searchParams.set('inactivity_timeout', String(binding.inactivityTimeoutSec));
  if (binding.prompt && proModel(binding)) url.searchParams.set('prompt', binding.prompt);
  if (binding.keyterms?.length)
    url.searchParams.set('keyterms_prompt', JSON.stringify(binding.keyterms));
  const languageCodes = assemblyAiLanguageCodes(binding, language);
  // Encoded like keyterms_prompt, as a JSON array.
  if (languageCodes) url.searchParams.set('language_codes', JSON.stringify(languageCodes));
  return url.toString();
}

export class AssemblyAiStt implements SpeechToText {
  readonly capabilities;
  readonly binding: Readonly<AssemblyAiBinding>;
  private sessions = 0;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: AssemblyAiBinding = {},
    private readonly clock: Clock = systemClock,
    /** The agent's keyterm settings; the call's variables fill them in at start (STT-11). */
    private readonly agent: AssemblyAiCallKeyterms = {},
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.capabilities = assemblyAiCapabilitiesFor(binding);
  }

  async start(input: KeytermStart): Promise<AssemblyAiSession> {
    if (!this.capabilities.inputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('AssemblyAI requires a native PCM or mu-law format');
    if (!assemblyAiSupportsLanguage(this.binding, input.language))
      throw new TypeError(
        `AssemblyAI model ${modelOf(this.binding)} does not support ${input.language}`,
      );
    const primary = this.binding.region ?? 'default';
    const regions = [primary, this.binding.fallbackRegion ?? primary];
    for (const [attempt, region] of regions.entries()) {
      input.signal.throwIfAborted();
      try {
        return await this.connect(input, region);
      } catch (error) {
        if (attempt === regions.length - 1 || !retryableConnect(error, input.signal)) throw error;
        logger.warn('stt_connect_retry', {
          sessionId: input.sessionId,
          region,
          nextRegion: regions[attempt + 1],
          ...errorFields(error),
        });
      }
    }
    throw new Error('unreachable');
  }

  private async connect(input: KeytermStart, region: AssemblyAiRegion): Promise<AssemblyAiSession> {
    const timeoutMs = this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const keyterms = callKeyterms(this.binding.keyterms, this.agent, input.variables);
    const socket = this.net.websocket(
      assemblyAiUrl({ ...this.binding, region, keyterms }, input.format, input.language),
      { headers: { Authorization: this.key } },
    );
    const session = new AssemblyAiSession(socket, input, this.binding, this.clock, ++this.sessions);
    const cancel = this.clock.setTimeout(
      () =>
        session.abandon(
          new AssemblyAiProviderError(
            `AssemblyAI Begin not received within ${timeoutMs}ms`,
            'connect-timeout',
            true,
          ),
        ),
      timeoutMs,
    );
    try {
      await session.ready;
    } finally {
      cancel();
    }
    return session;
  }
}

/** A timeout, a retryable provider close or a transport error; never an abort or a refusal. */
function retryableConnect(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof AssemblyAiProviderError) return error.retryable;
  return !(error instanceof DOMException && error.name === 'AbortError');
}
