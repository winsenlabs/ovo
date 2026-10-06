import {
  sameFormat,
  type AudioFormat,
  type Clock,
  type NetPort,
  type SpeechToText,
} from '@winsendotai/ovo-contracts';
import { createLogger, errorFields, systemClock } from '@winsendotai/ovo-plugin-kit';
import { baseLanguage, scribeCapabilitiesFor, scribeSupportsLanguage } from './capabilities.ts';
import { ElevenLabsSttError } from './protocol.ts';
import { ScribeSession } from './session.ts';

const logger = createLogger({ service: 'stt-elevenlabs' });

export const SCRIBE_MODELS = ['scribe_v2_realtime'] as const;
export type ScribeModel = (typeof SCRIBE_MODELS)[number];
export const SCRIBE_REGIONS = ['default', 'us', 'eu', 'in', 'sg'] as const;
export type ScribeRegion = (typeof SCRIBE_REGIONS)[number];

export interface ElevenLabsSttBinding {
  model?: ScribeModel;
  region?: ScribeRegion;
  /** A second region tried once when the first handshake times out or fails retryably. */
  fallbackRegion?: ScribeRegion;
  /** Deadline for the socket open and session_started; defaults to {@link DEFAULT_CONNECT_TIMEOUT_MS}. */
  connectTimeoutMs?: number;
  /**
   * 'manual' (the default) commits only when the host forces an endpoint, as the POC did after
   * ~250 ms of local silence; 'vad' lets the provider commit after its own silence window.
   */
  commitStrategy?: 'manual' | 'vad';
  vadSilenceThresholdSecs?: number;
  vadThreshold?: number;
  minSpeechDurationMs?: number;
  minSilenceDurationMs?: number;
  /**
   * 'auto' (the default) sends no language_code: the model detects the language and keeps
   * code-mixed Hindi-English intact, as the POC did for en and hi. 'session' pins the session
   * language's base code (ta-IN becomes `ta`).
   */
  languageMode?: 'auto' | 'session';
  keyterms?: readonly string[];
  noVerbatim?: boolean;
  /** False asks for zero retention, which the provider allows on enterprise plans only. */
  enableLogging?: boolean;
}

/** Two attempts at this deadline fit the worker's fifteen-second pre-session audio buffer. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 6_000;

const HOSTS: Readonly<Record<ScribeRegion, string>> = Object.freeze({
  default: 'api.elevenlabs.io',
  us: 'api.us.elevenlabs.io',
  eu: 'api.eu.residency.elevenlabs.io',
  in: 'api.in.residency.elevenlabs.io',
  sg: 'api.sg.residency.elevenlabs.io',
});
export const SCRIBE_HOSTS: readonly string[] = Object.freeze(Object.values(HOSTS));

function audioFormat(format: AudioFormat): string {
  if (format.encoding === 'mulaw') return 'ulaw_8000';
  return `pcm_${format.sampleRate}`;
}

export function scribeUrl(
  binding: ElevenLabsSttBinding,
  format: AudioFormat,
  language: string,
): string {
  const url = new URL(`wss://${HOSTS[binding.region ?? 'default']}/v1/speech-to-text/realtime`);
  url.searchParams.set('model_id', binding.model ?? 'scribe_v2_realtime');
  url.searchParams.set('audio_format', audioFormat(format));
  const strategy = binding.commitStrategy ?? 'manual';
  url.searchParams.set('commit_strategy', strategy);
  if (binding.languageMode === 'session')
    url.searchParams.set('language_code', baseLanguage(language));
  if (strategy === 'vad') {
    const vad: [string, number | undefined][] = [
      ['vad_silence_threshold_secs', binding.vadSilenceThresholdSecs],
      ['vad_threshold', binding.vadThreshold],
      ['min_speech_duration_ms', binding.minSpeechDurationMs],
      ['min_silence_duration_ms', binding.minSilenceDurationMs],
    ];
    for (const [name, value] of vad)
      if (value !== undefined) url.searchParams.set(name, String(value));
  }
  // [unconfirmed: the reference types `keyterms` as an array without its query encoding; a
  // repeated parameter is the usual form.]
  for (const term of binding.keyterms ?? []) url.searchParams.append('keyterms', term);
  if (binding.noVerbatim) url.searchParams.set('no_verbatim', 'true');
  if (binding.enableLogging === false) url.searchParams.set('enable_logging', 'false');
  return url.toString();
}

export class ElevenLabsStt implements SpeechToText {
  readonly capabilities;
  readonly binding: Readonly<ElevenLabsSttBinding>;
  private sessions = 0;

  constructor(
    private readonly net: NetPort,
    private readonly key: string,
    binding: ElevenLabsSttBinding = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.binding = Object.freeze(structuredClone(binding));
    this.capabilities = scribeCapabilitiesFor(binding);
  }

  async start(input: Parameters<SpeechToText['start']>[0]): Promise<ScribeSession> {
    if (!this.capabilities.inputFormats.some((format) => sameFormat(format, input.format)))
      throw new TypeError('ElevenLabs STT requires 8 kHz mu-law or 8/16 kHz PCM');
    if (!scribeSupportsLanguage(input.language))
      throw new TypeError(`ElevenLabs Scribe does not support ${input.language}`);
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

  private async connect(
    input: Parameters<SpeechToText['start']>[0],
    region: ScribeRegion,
  ): Promise<ScribeSession> {
    const timeoutMs = this.binding.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const socket = this.net.websocket(
      scribeUrl({ ...this.binding, region }, input.format, input.language),
      { headers: { 'xi-api-key': this.key } },
    );
    const session = new ScribeSession(socket, input, this.clock, ++this.sessions);
    const cancel = this.clock.setTimeout(
      () =>
        session.abandon(
          new ElevenLabsSttError(
            `ElevenLabs session_started not received within ${timeoutMs}ms`,
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

/** A timeout, a retryable provider failure or a transport error; never an abort or a refusal. */
function retryableConnect(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return false;
  if (error instanceof ElevenLabsSttError) return error.retryable;
  return !(error instanceof DOMException && error.name === 'AbortError');
}
