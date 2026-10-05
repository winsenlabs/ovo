import {
  MULAW_8K,
  PCM16_16K,
  PCM16_8K,
  sameFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { systemClock } from '@winsendotai/ovo-plugin-kit';
import { AssemblyAiProviderError, AssemblyAiSession } from './session.ts';

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
  minTurnSilenceMs?: number;
  maxTurnSilenceMs?: number;
  endOfTurnConfidenceThreshold?: number;
  keyterms?: readonly string[];
}

/**
 * Two attempts at this deadline stay inside the worker's ten-second pre-session audio buffer, so
 * a slow handshake costs a retry rather than the call.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

const MULTILINGUAL_LANGUAGES = ['en', 'es', 'de', 'fr', 'pt', 'it'];
const PRO_3_5_LANGUAGES = [
  'ar',
  'ca',
  'da',
  'nl',
  'en',
  'fi',
  'fr',
  'de',
  'he',
  'hi',
  'it',
  'ja',
  'zh',
  'no',
  'pt',
  'es',
  'sv',
  'tr',
  'vi',
];
// https://www.assemblyai.com/docs/streaming/multilingual-transcription (retrieved 2026-10-06).
const PRO_3_6_LANGUAGES = [
  ...PRO_3_5_LANGUAGES,
  'af',
  'yue',
  'et',
  'gl',
  'ko',
  'mr',
  'nn',
  'fa',
  'ro',
  'ru',
  'ur',
  'xh',
  'zu',
];
const MODEL_LANGUAGES: Readonly<Record<AssemblyAiModel, readonly string[]>> = Object.freeze({
  'universal-streaming-english': ['en'],
  'universal-streaming-multilingual': MULTILINGUAL_LANGUAGES,
  'universal-3-5-pro': PRO_3_5_LANGUAGES,
  'universal-3-6-pro': PRO_3_6_LANGUAGES,
});

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

function modelOf(binding: Pick<AssemblyAiBinding, 'model'>): AssemblyAiModel {
  return binding.model ?? 'universal-streaming-english';
}

/** Base language codes the binding's model transcribes. */
export function assemblyAiLanguages(binding: Pick<AssemblyAiBinding, 'model'>): readonly string[] {
  return MODEL_LANGUAGES[modelOf(binding)] ?? ['en'];
}

/** Whether the binding's model transcribes a BCP-47 tag such as `hi-IN`. */
export function assemblyAiSupportsLanguage(
  binding: Pick<AssemblyAiBinding, 'model'>,
  language: string,
): boolean {
  return assemblyAiLanguages(binding).includes(baseLanguage(language));
}

/** The binding-aware capability set; the manifest's languages are the default model's. */
export function assemblyAiCapabilitiesFor(binding: Pick<AssemblyAiBinding, 'model'>) {
  return { ...ASSEMBLYAI_CAPABILITIES, languages: assemblyAiLanguages(binding) };
}

function baseLanguage(language: string): string {
  return language.split('-')[0]!.toLowerCase();
}

/**
 * `language_codes` biases the code-switching pro models. Indian callers mix English into Hindi
 * and other Indian languages, so an `-IN` tag also lists English.
 */
export function assemblyAiLanguageCodes(
  binding: Pick<AssemblyAiBinding, 'model'>,
  language: string | undefined,
): string[] | undefined {
  const model = modelOf(binding);
  if (!language || (model !== 'universal-3-5-pro' && model !== 'universal-3-6-pro'))
    return undefined;
  const base = baseLanguage(language);
  if (!assemblyAiLanguages(binding).includes(base)) return undefined;
  return base !== 'en' && language.toUpperCase().endsWith('-IN') ? [base, 'en'] : [base];
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
  if (binding.minTurnSilenceMs !== undefined)
    url.searchParams.set('min_turn_silence', String(binding.minTurnSilenceMs));
  if (binding.maxTurnSilenceMs !== undefined)
    url.searchParams.set('max_turn_silence', String(binding.maxTurnSilenceMs));
  if (binding.endOfTurnConfidenceThreshold !== undefined)
    url.searchParams.set(
      'end_of_turn_confidence_threshold',
      String(binding.endOfTurnConfidenceThreshold),
    );
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
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.capabilities = assemblyAiCapabilitiesFor(binding);
  }

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<AssemblyAiSession> {
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
        console.error(
          JSON.stringify({
            service: 'stt-assemblyai',
            event: 'stt_connect_retry',
            level: 'warn',
            sessionId: input.sessionId,
            region,
            nextRegion: regions[attempt + 1],
            code: error instanceof AssemblyAiProviderError ? error.code : undefined,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    throw new Error('unreachable');
  }

  private async connect(
    input: Parameters<SpeechToText['start']>[0],
    region: AssemblyAiRegion,
  ): Promise<AssemblyAiSession> {
    const timeoutMs = this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const socket = this.net.websocket(
      assemblyAiUrl({ ...this.binding, region }, input.format, input.language),
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
