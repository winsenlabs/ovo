import {
  MULAW_8K,
  PCM16_24K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { createLogger, errorFields, systemClock } from '@winsendotai/ovo-plugin-kit';
import { OpenAiRealtimeSttError } from './protocol.ts';
import { OpenAiRealtimeSession } from './session.ts';

const logger = createLogger({ service: 'stt-openai-realtime' });

/**
 * `gpt-live-transcribe` streams deltas while the caller speaks and needs a manual commit; the
 * others transcribe a committed turn and may let the provider's VAD commit it.
 */
export const REALTIME_STT_MODELS = [
  'gpt-live-transcribe',
  'gpt-transcribe',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
] as const;
export type RealtimeSttModel = (typeof REALTIME_STT_MODELS)[number];
export const REALTIME_STT_HOST = 'api.openai.com';
export const REALTIME_STT_DELAYS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

export interface OpenAiRealtimeSttBinding {
  model?: RealtimeSttModel;
  /**
   * 'manual' (the default) commits only when the host forces an endpoint, after its own short
   * silence, as the Scribe binding does. The VAD modes let the provider commit each turn.
   */
  turnDetection?: 'manual' | 'server_vad' | 'semantic_vad';
  /** server_vad only. */
  silenceDurationMs?: number;
  vadThreshold?: number;
  prefixPaddingMs?: number;
  /** semantic_vad only. */
  eagerness?: 'low' | 'medium' | 'high' | 'auto';
  /** 'auto' (the default) names no language; 'session' passes the session language's base code. */
  languageMode?: 'auto' | 'session';
  prompt?: string;
  keywords?: readonly string[];
  /** The latency/accuracy trade-off for streamed deltas. */
  delay?: (typeof REALTIME_STT_DELAYS)[number];
  noiseReduction?: 'near_field' | 'far_field';
  /** Deadline for the socket open and `session.created`. */
  connectTimeoutMs?: number;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 6_000;

/**
 * Mu-law first: the carrier's own format reaches the provider without a transcode. The only PCM
 * rate the provider accepts is 24 kHz; the host adapter resamples anything else to it.
 */
const INPUT_FORMATS = [MULAW_8K, PCM16_24K];

export function realtimeSttCapabilities(binding: Pick<OpenAiRealtimeSttBinding, 'turnDetection'>) {
  const vad = (binding.turnDetection ?? 'manual') !== 'manual';
  return Object.freeze({
    inputFormats: INPUT_FORMATS,
    languages: ['*'],
    interim: true,
    wordTimestamps: false,
    // Manual commit: a final and its end of turn follow only a host commit, so a release must
    // select a VAD (local endpointing) rather than rely on provider turn signals.
    turnSignals: vad ? (['speech-start', 'end-of-turn'] as const) : ([] as const),
    forceEndpoint: true,
    ttfsP99Ms: 800,
  });
}

export const REALTIME_STT_CAPABILITIES = realtimeSttCapabilities({});

/**
 * The transcription-session WebSocket. [unconfirmed: the GA guide names no URL for a WebSocket
 * transcription session; this is the form OpenAI's own cookbook uses
 * (https://developers.openai.com/cookbook/examples/speech_transcription_methods, retrieved
 * 2026-10-06), with the GA `session.update` shape below.]
 */
export const REALTIME_STT_URL = `wss://${REALTIME_STT_HOST}/v1/realtime?intent=transcription`;

/** Uses the `languages` list the newer models take, or the older models' single `language`. */
function languageField(binding: OpenAiRealtimeSttBinding, language: string) {
  if (binding.languageMode !== 'session') return {};
  const base = language.split('-')[0]!.toLowerCase();
  const model = binding.model ?? 'gpt-live-transcribe';
  return model === 'gpt-live-transcribe' || model === 'gpt-transcribe'
    ? { languages: [base] }
    : { language: base };
}

function turnDetection(binding: OpenAiRealtimeSttBinding) {
  if (binding.turnDetection === 'server_vad')
    return {
      type: 'server_vad',
      ...(binding.silenceDurationMs !== undefined
        ? { silence_duration_ms: binding.silenceDurationMs }
        : {}),
      ...(binding.vadThreshold !== undefined ? { threshold: binding.vadThreshold } : {}),
      ...(binding.prefixPaddingMs !== undefined
        ? { prefix_padding_ms: binding.prefixPaddingMs }
        : {}),
    };
  if (binding.turnDetection === 'semantic_vad')
    return { type: 'semantic_vad', ...(binding.eagerness ? { eagerness: binding.eagerness } : {}) };
  return null;
}

/** The GA `session.update` that configures a transcription session. */
export function sessionUpdate(
  binding: OpenAiRealtimeSttBinding,
  format: AudioFormat,
  language: string,
): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format:
            format.encoding === 'mulaw'
              ? { type: 'audio/pcmu' }
              : { type: 'audio/pcm', rate: format.sampleRate },
          transcription: {
            model: binding.model ?? 'gpt-live-transcribe',
            ...languageField(binding, language),
            ...(binding.prompt ? { prompt: binding.prompt } : {}),
            ...(binding.keywords?.length ? { keywords: [...binding.keywords] } : {}),
            // [unconfirmed: the guide documents `delay` for gpt-live-transcribe; the reference
            // says it applies to gpt-realtime-whisper. It is sent only when the binding sets it.]
            ...(binding.delay ? { delay: binding.delay } : {}),
          },
          turn_detection: turnDetection(binding),
          ...(binding.noiseReduction ? { noise_reduction: { type: binding.noiseReduction } } : {}),
        },
      },
    },
  };
}

export class OpenAiRealtimeStt implements SpeechToText {
  readonly capabilities;
  readonly binding: Readonly<OpenAiRealtimeSttBinding>;
  private sessions = 0;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: OpenAiRealtimeSttBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    if ((binding.model ?? 'gpt-live-transcribe') === 'gpt-live-transcribe')
      if ((binding.turnDetection ?? 'manual') !== 'manual')
        // The provider: "The model doesn't support server_vad or semantic_vad."
        throw new TypeError('gpt-live-transcribe needs manual commits (turnDetection: manual)');
    this.capabilities = realtimeSttCapabilities(binding);
  }

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<OpenAiRealtimeSession> {
    if (!this.capabilities.inputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('OpenAI realtime STT requires 8 kHz mu-law or 24 kHz PCM');
    input.signal.throwIfAborted();
    const timeoutMs = this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const socket = this.net.websocket(REALTIME_STT_URL, {
      headers: { Authorization: `Bearer ${this.key}` },
    });
    const session = new OpenAiRealtimeSession(
      socket,
      input,
      JSON.stringify(sessionUpdate(this.binding, input.format, input.language)),
      this.clock,
      ++this.sessions,
    );
    const cancel = this.clock.setTimeout(
      () =>
        session.abandon(
          new OpenAiRealtimeSttError(
            `OpenAI session.created not received within ${timeoutMs}ms`,
            'connect-timeout',
            true,
          ),
        ),
      timeoutMs,
    );
    try {
      await session.ready;
    } catch (error) {
      logger.warn('stt_connect_failed', { sessionId: input.sessionId, ...errorFields(error) });
      throw error;
    } finally {
      cancel();
    }
    return session;
  }
}
