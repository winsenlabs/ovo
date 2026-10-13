import { createHash } from 'node:crypto';
import { canonicalJson, type AudioFormat } from '@winsendotai/ovo-contracts';

// Wire facts below are from https://docs.cartesia.ai/api-reference/tts/websocket.md and
// https://docs.cartesia.ai/build-with-cartesia/tts-models/latest.md (both retrieved 2026-10-13).

export const CARTESIA_HOST = 'api.cartesia.ai';
/** The only `cartesia_version` the 2026-10-13 references list; the query parameter wins. */
export const CARTESIA_VERSION = '2026-08-14';

/**
 * Sonic 3.6 only. The dated snapshot is the default so a cached clip cannot drift when the alias
 * moves. sonic-2, sonic-turbo and sonic-3-2025-10-27 sunset on 2026-10-20, and `sonic-latest` now
 * aliases the beta `sonic-preview` (https://docs.cartesia.ai/build-with-cartesia/tts-models/older-models.md).
 */
export const SONIC_MODELS = ['sonic-3.6-2026-08-27', 'sonic-3.6'] as const;
export type SonicModel = (typeof SONIC_MODELS)[number];
export const DEFAULT_MODEL: SonicModel = 'sonic-3.6-2026-08-27';

export const SONIC_EMOTIONS = ['neutral', 'calm', 'angry', 'content', 'sad'] as const;
export type SonicEmotion = (typeof SONIC_EMOTIONS)[number];

/** The `language` enum of the generation request: 44 base codes, then the regional locales. */
export const SONIC_LANGUAGES: readonly string[] = Object.freeze(
  (
    'en fr de es pt zh ja hi it ko nl pl ru sv tr tl bg ro ar cs el fi hr ms sk da ta uk hu no ' +
    'vi bn th he ka id te gu kn ml mr pa or ur ' +
    'bg-BG bn-IN cs-CZ da-DK de-DE el-GR en-AU en-CA en-GB en-IE en-IN en-NZ en-SG en-US en-ZA ' +
    'es-ES es-MX es-US fi-FI fr-CA fr-FR gu-IN he-IL hi-IN hr-HR hu-HU id-ID it-IT ja-JP ka-GE ' +
    'kn-IN ko-KR ml-IN mr-IN ms-MY nl-BE nl-NL no-NO or-IN pa-IN pl-PL pt-BR pt-PT ro-RO ru-RU ' +
    'sk-SK sv-SE ta-IN te-IN th-TH tl-PH tr-TR uk-UA ur-IN vi-VN zh-CN'
  ).split(' '),
);

/** Non-secret binding config. The API key is the binding credential, never a field here. */
export interface CartesiaTtsBinding {
  model?: SonicModel;
  voiceId?: string;
  /** Pins the request `language`; unset, each utterance uses the session language. */
  language?: string;
  /** `auto` (the provider default), `off`, or a language or locale such as `en-IN`. */
  normalization?: string;
  accent?: string;
  speed?: number;
  volume?: number;
  emotion?: SonicEmotion;
  pronunciationDictId?: string;
  /** 0 is the documented "custom buffering": OVO sends whole clauses, so render at once. */
  maxBufferDelayMs?: number;
  /** Contexts one session may hold at once; Pro allows 3 account-wide. */
  maxContexts?: number;
  connectTimeoutMs?: number;
  apiVersion?: typeof CARTESIA_VERSION;
}

export const DEFAULT_MAX_CONTEXTS = 3;
export const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;

export function socketUrl(binding: Readonly<CartesiaTtsBinding>): string {
  const version = binding.apiVersion ?? CARTESIA_VERSION;
  return `wss://${CARTESIA_HOST}/tts/websocket?cartesia_version=${encodeURIComponent(version)}`;
}

/** The raw `output_format` for a native format, or undefined when Sonic cannot emit it as is. */
export function outputFormat(
  format: AudioFormat,
): { container: 'raw'; encoding: string; sample_rate: number } | undefined {
  if (format.channels !== 1) return undefined;
  const { encoding, sampleRate } = format;
  if (encoding === 'mulaw' && sampleRate === 8000)
    return { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 };
  if (
    encoding === 'pcm_s16le' &&
    (sampleRate === 8000 || sampleRate === 16000 || sampleRate === 24000)
  )
    return { container: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate };
  return undefined;
}

const CANONICAL = new Map(SONIC_LANGUAGES.map((tag) => [tag.toLowerCase(), tag]));

/**
 * The provider's tag for `language`: matching is case-insensitive and `en_IN` is an alias of
 * `en-IN` [doc]; a locale Sonic lacks falls back to its base code. Undefined when neither exists.
 */
export function sonicLanguage(language: string): string | undefined {
  const key = language.trim().replace('_', '-').toLowerCase();
  return CANONICAL.get(key) ?? CANONICAL.get(key.split('-')[0]!);
}

export function voiceOf(binding: Readonly<CartesiaTtsBinding>, voice?: string): string {
  const chosen = voice ?? binding.voiceId;
  if (!chosen) throw new TypeError('Cartesia TTS needs a voiceId (binding or agent voice)');
  return chosen;
}

function generationConfig(binding: Readonly<CartesiaTtsBinding>) {
  const config = {
    ...(binding.volume === undefined ? {} : { volume: binding.volume }),
    ...(binding.speed === undefined ? {} : { speed: binding.speed }),
    ...(binding.emotion === undefined ? {} : { emotion: binding.emotion }),
  };
  return Object.keys(config).length ? config : undefined;
}

/**
 * Every field a generation request carries besides `context_id`, `transcript`, `continue` and
 * `flush`. The reference requires them unchanged on every input of one context, so each frame of a
 * context is built from one call of this.
 */
export function requestFields(
  binding: Readonly<CartesiaTtsBinding>,
  input: { format: AudioFormat; language: string; voice?: string },
): Record<string, unknown> {
  const requested = binding.language ?? input.language;
  const language = sonicLanguage(requested);
  if (!language) throw new TypeError(`Cartesia Sonic does not speak ${requested}`);
  const config = generationConfig(binding);
  return {
    model_id: binding.model ?? DEFAULT_MODEL,
    voice: voiceOf(binding, input.voice),
    output_format: outputFormat(input.format),
    language,
    ...(binding.normalization ? { normalization: binding.normalization } : {}),
    ...(binding.accent ? { accent: binding.accent } : {}),
    ...(config ? { generation_config: config } : {}),
    ...(binding.pronunciationDictId ? { pronunciation_dict_id: binding.pronunciationDictId } : {}),
    max_buffer_delay_ms: binding.maxBufferDelayMs ?? 0,
  };
}

/**
 * `cartesia-v1-<sha256/16>` over everything that changes the rendered bytes, defaults resolved so
 * `{}` and an explicit default share clips: model, voice, language, normalization, accent,
 * generation_config, pronunciation dictionary and the output format. Buffering, slots and
 * timeouts do not change the audio and stay out.
 */
export function cacheRevision(
  binding: Readonly<CartesiaTtsBinding>,
  format: AudioFormat,
  voice: string,
): string {
  const fields = {
    model: binding.model ?? DEFAULT_MODEL,
    voice,
    language: binding.language ?? null,
    normalization: binding.normalization ?? 'auto',
    accent: binding.accent ?? null,
    generation: {
      volume: binding.volume ?? 1,
      speed: binding.speed ?? 1,
      emotion: binding.emotion ?? null,
    },
    pronunciationDictId: binding.pronunciationDictId ?? null,
    format: [format.encoding, format.sampleRate, format.channels],
  };
  const digest = createHash('sha256').update(canonicalJson(fields)).digest('hex');
  return `cartesia-v1-${digest.slice(0, 16)}`;
}
