import { createHash } from 'node:crypto';
import { canonicalJson, type AudioFormat } from '@winsendotai/ovo-contracts';

export type ElevenLabsTtsModel =
  'eleven_flash_v2_5' | 'eleven_turbo_v2_5' | 'eleven_multilingual_v2';
export type ElevenLabsRegion = 'global' | 'us' | 'eu-residency' | 'in-residency' | 'sg-residency';

/** Non-secret binding config. The API key is the binding credential, never a field here. */
export interface ElevenLabsTtsBinding {
  model?: ElevenLabsTtsModel;
  voiceId?: string;
  stability?: number;
  similarityBoost?: number;
  style?: number;
  speed?: number;
  useSpeakerBoost?: boolean;
  /** ISO 639-1; enforces the language on models that support it. Unset lets the model infer it. */
  languageCode?: string;
  applyTextNormalization?: 'auto' | 'on' | 'off';
  seed?: number;
  /** At most 3 (`pronunciation_dictionary_locators`). */
  pronunciationDictionaries?: { id: string; versionId?: string }[];
  autoMode?: boolean;
  chunkLengthSchedule?: number[];
  region?: ElevenLabsRegion;
  transport?: 'websocket' | 'http';
  /** Seconds the pooled socket may idle (provider maximum 180). */
  inactivityTimeoutS?: number;
  connectTimeoutMs?: number;
  /** Stream over HTTP when the WebSocket cannot be opened (default true). */
  httpFallback?: boolean;
  enableLogging?: boolean;
}

/** Monika Sogam, the founder-selected voice (2026-10-06). */
export const DEFAULT_VOICE_ID = 'ZUrEGyu8GFMwnHbvLhv2';
export const DEFAULT_MODEL: ElevenLabsTtsModel = 'eleven_flash_v2_5';
/** The settings the collections POC shipped with (lib/tts.js). */
export const DEFAULT_VOICE_SETTINGS = Object.freeze({
  stability: 0.5,
  similarityBoost: 0.8,
  speed: 1,
});

export const REGION_HOSTS: Readonly<Record<ElevenLabsRegion, string>> = Object.freeze({
  global: 'api.elevenlabs.io',
  us: 'api.us.elevenlabs.io',
  'eu-residency': 'api.eu.residency.elevenlabs.io',
  'in-residency': 'api.in.residency.elevenlabs.io',
  'sg-residency': 'api.sg.residency.elevenlabs.io',
});

/** Characters per request: 40k for the v2.5 models, 10k for multilingual v2. */
export function textLimit(binding: Readonly<ElevenLabsTtsBinding>): number {
  return (binding.model ?? DEFAULT_MODEL) === 'eleven_multilingual_v2' ? 10_000 : 40_000;
}

/** `output_format` for a native format, or undefined when ElevenLabs cannot emit it. */
export function outputFormat(format: AudioFormat): string | undefined {
  if (format.channels !== 1) return undefined;
  if (format.encoding === 'mulaw') return format.sampleRate === 8000 ? 'ulaw_8000' : undefined;
  if (format.encoding === 'pcm_s16le' && [8000, 16000, 24000].includes(format.sampleRate))
    return `pcm_${format.sampleRate}`;
  return undefined;
}

export function voiceOf(binding: Readonly<ElevenLabsTtsBinding>, voice?: string): string {
  return voice ?? binding.voiceId ?? DEFAULT_VOICE_ID;
}

/** The `voice_settings` object, with the POC defaults filled in. */
export function voiceSettings(binding: Readonly<ElevenLabsTtsBinding>): Record<string, unknown> {
  return {
    stability: binding.stability ?? DEFAULT_VOICE_SETTINGS.stability,
    similarity_boost: binding.similarityBoost ?? DEFAULT_VOICE_SETTINGS.similarityBoost,
    speed: binding.speed ?? DEFAULT_VOICE_SETTINGS.speed,
    ...(binding.style === undefined ? {} : { style: binding.style }),
    ...(binding.useSpeakerBoost === undefined
      ? {}
      : { use_speaker_boost: binding.useSpeakerBoost }),
  };
}

export function dictionaryLocators(binding: Readonly<ElevenLabsTtsBinding>) {
  return (binding.pronunciationDictionaries ?? []).map((entry) => ({
    pronunciation_dictionary_id: entry.id,
    ...(entry.versionId ? { version_id: entry.versionId } : {}),
  }));
}

/**
 * Every binding field that changes the rendered bytes, defaults resolved, so `{}` and an explicit
 * default share clips while any edit to the voice re-keys them (TTS-13). Transport, region,
 * timeouts and logging do not change the audio and stay out.
 */
function audioFields(binding: Readonly<ElevenLabsTtsBinding>): Record<string, unknown> {
  return {
    voiceSettings: voiceSettings(binding),
    languageCode: binding.languageCode ?? null,
    applyTextNormalization: binding.applyTextNormalization ?? 'auto',
    seed: binding.seed ?? null,
    pronunciation: dictionaryLocators(binding),
    autoMode: binding.autoMode ?? true,
    chunkLengthSchedule: binding.chunkLengthSchedule ?? null,
  };
}

export function cacheRevision(
  binding: Readonly<ElevenLabsTtsBinding>,
  format: AudioFormat,
): string {
  const digest = createHash('sha256')
    .update(canonicalJson(audioFields(binding)))
    .digest('hex');
  return `elevenlabs-${format.encoding}-${format.sampleRate}-v1-${digest.slice(0, 16)}`;
}

function base(binding: Readonly<ElevenLabsTtsBinding>, scheme: 'https' | 'wss', voice: string) {
  const host = REGION_HOSTS[binding.region ?? 'global'];
  return `${scheme}://${host}/v1/text-to-speech/${encodeURIComponent(voice)}`;
}

/** The session's pooled multi-context socket; one per (voice, format) because both sit in the URL. */
export function multiStreamUrl(
  binding: Readonly<ElevenLabsTtsBinding>,
  voice: string,
  format: AudioFormat,
): string {
  const url = new URL(`${base(binding, 'wss', voice)}/multi-stream-input`);
  const query = url.searchParams;
  query.set('model_id', binding.model ?? DEFAULT_MODEL);
  query.set('output_format', outputFormat(format)!);
  query.set('inactivity_timeout', String(binding.inactivityTimeoutS ?? 180));
  query.set('auto_mode', String(binding.autoMode ?? true));
  if (binding.languageCode) query.set('language_code', binding.languageCode);
  if (binding.applyTextNormalization)
    query.set('apply_text_normalization', binding.applyTextNormalization);
  if (binding.seed !== undefined) query.set('seed', String(binding.seed));
  if (binding.enableLogging === false) query.set('enable_logging', 'false');
  return url.toString();
}

export function streamUrl(
  binding: Readonly<ElevenLabsTtsBinding>,
  voice: string,
  format: AudioFormat,
): string {
  const url = new URL(`${base(binding, 'https', voice)}/stream`);
  url.searchParams.set('output_format', outputFormat(format)!);
  if (binding.enableLogging === false) url.searchParams.set('enable_logging', 'false');
  return url.toString();
}

/** The HTTP stream body: the same model and voice fields the socket's first frame carries. */
export function streamBody(binding: Readonly<ElevenLabsTtsBinding>, text: string): string {
  const locators = dictionaryLocators(binding);
  return JSON.stringify({
    text,
    model_id: binding.model ?? DEFAULT_MODEL,
    voice_settings: voiceSettings(binding),
    ...(binding.languageCode ? { language_code: binding.languageCode } : {}),
    ...(binding.applyTextNormalization
      ? { apply_text_normalization: binding.applyTextNormalization }
      : {}),
    ...(binding.seed === undefined ? {} : { seed: binding.seed }),
    ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}),
  });
}

/** Fields only the first text frame of a context may carry. */
export function contextOpening(binding: Readonly<ElevenLabsTtsBinding>): Record<string, unknown> {
  const locators = dictionaryLocators(binding);
  return {
    voice_settings: voiceSettings(binding),
    ...(binding.chunkLengthSchedule?.length
      ? { generation_config: { chunk_length_schedule: binding.chunkLengthSchedule } }
      : {}),
    ...(locators.length ? { pronunciation_dictionary_locators: locators } : {}),
  };
}
