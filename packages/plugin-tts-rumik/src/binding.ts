import { createHash } from 'node:crypto';
import { canonicalJson, type AudioFormat } from '@winsendotai/ovo-contracts';

export type RumikModel = 'mulberry' | 'muga';
export const SPEAKERS = [
  'emma',
  'mia',
  'sophia',
  'ava',
  'ira',
  'siya',
  'aisha',
  'zoya',
  'lucas',
  'noah',
  'theo',
  'adam',
] as const;
export type RumikSpeaker = (typeof SPEAKERS)[number];
/** The six muga moods (https://docs.rumik.ai/muga, retrieved 2026-10-13). */
export const TONES = ['neutral', 'happy', 'excited', 'sad', 'angry', 'whisper'] as const;
export type RumikTone = (typeof TONES)[number];

/** Non-secret binding config. The `rk_live_` key is the binding credential, never a field here. */
export interface RumikTtsBinding {
  model?: RumikModel;
  /** mulberry only: one of the twelve named voices, still steered by `description`. */
  speaker?: RumikSpeaker;
  /**
   * mulberry builds the voice from this on every request and bills its characters on every
   * request too (https://docs.rumik.ai/pricing/pay-as-you-go), so OVO caps it at 300 characters.
   */
  description?: string;
  /** muga: the `[tone]` prefixed to a segment that does not start with one. */
  defaultTone?: RumikTone;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  maxNewTokens?: number;
  /**
   * Rumik's own normaliser (lakh/crore, dates, quoted IDs). Off by default: OVO's speech normaliser
   * already writes replies for the ear, and running both would read some figures twice over.
   */
  normalization?: boolean;
  transport?: 'websocket' | 'http';
  /** Render over `POST /v1/tts` when the socket cannot be minted or drops before audio (default true). */
  httpFallback?: boolean;
  connectTimeoutMs?: number;
}

export const RUMIK_HOST = 'silk-api.rumik.ai';
export const MINT_URL = `https://${RUMIK_HOST}/v1/tts/ws-connect`;
export const SYNTHESIS_URL = `https://${RUMIK_HOST}/v1/tts`;
export const DEFAULT_MODEL: RumikModel = 'mulberry';
export const DEFAULT_TONE: RumikTone = 'neutral';
export const MAX_DESCRIPTION_CHARS = 300;
/** `text` maxLength in the OpenAPI `TTSRequest` and `WsConnectRequest` schemas. */
export const MAX_TEXT_CHARS = 2000;
/** The mint's required `text`; it is never spoken. Rumik's own Pipecat plugin mints with "init". */
export const MINT_TEXT = 'init';
/** Server defaults (OpenAPI `TTSRequest`), so an unset field and its default share cached clips. */
const SAMPLING_DEFAULTS = Object.freeze({
  temperature: 0.6,
  top_p: 0.95,
  top_k: 50,
  repetition_penalty: 1.2,
  max_new_tokens: 2048,
});

const LONGEST_TONE_PREFIX = Math.max(...TONES.map((tone) => `[${tone}] `.length));
const LEADING_TONE = new RegExp(`^\\[(?:${TONES.join('|')})\\]`);

export const modelOf = (binding: Readonly<RumikTtsBinding>): RumikModel =>
  binding.model ?? DEFAULT_MODEL;

const chars = (text: string) => [...text].length;

/** Characters a caller may pass: muga keeps room for the tone prefix under the 2000 limit. */
export function textLimit(binding: Readonly<RumikTtsBinding>): number {
  return modelOf(binding) === 'muga' ? MAX_TEXT_CHARS - LONGEST_TONE_PREFIX : MAX_TEXT_CHARS;
}

/** `audio_format` for a native format, or undefined. Rumik has no 8 or 16 kHz PCM. */
export function audioFormatOf(format: AudioFormat): 'mulaw' | 'pcm' | undefined {
  if (format.channels !== 1) return undefined;
  if (format.encoding === 'mulaw' && format.sampleRate === 8000) return 'mulaw';
  if (format.encoding === 'pcm_s16le' && format.sampleRate === 24000) return 'pcm';
  return undefined;
}

/**
 * The text Rumik receives. muga "must start with a `[tone]`" and reads inline `<laugh>`-style
 * events where they stand (https://docs.rumik.ai/prompting-muga): a segment that already leads
 * with one of the six tags is sent as written, otherwise `[defaultTone] ` is prefixed. Nothing
 * inside the text is touched, so `<laugh>` and later tags survive. mulberry has no tags.
 */
export function spokenText(binding: Readonly<RumikTtsBinding>, text: string): string {
  if (modelOf(binding) !== 'muga') return text;
  const trimmed = text.trimStart();
  if (LEADING_TONE.test(trimmed)) return trimmed;
  return `[${binding.defaultTone ?? DEFAULT_TONE}] ${trimmed}`;
}

/** A named mulberry voice: the request's voice, else the binding's; unknown names are not sent. */
export function speakerOf(binding: Readonly<RumikTtsBinding>, voice?: string): string | undefined {
  if (modelOf(binding) !== 'mulberry') return undefined;
  const name = (voice ?? binding.speaker)?.toLowerCase();
  return SPEAKERS.find((speaker) => speaker === name);
}

/** The identity voice: muga has no named voices; mulberry is a speaker or the described voice. */
export function voiceOf(binding: Readonly<RumikTtsBinding>, voice?: string): string {
  return voice ?? binding.speaker ?? (modelOf(binding) === 'muga' ? 'muga' : 'described');
}

function sampling(binding: Readonly<RumikTtsBinding>): Record<string, number> {
  const out: Record<string, number> = {};
  if (binding.temperature !== undefined) out.temperature = binding.temperature;
  if (binding.topP !== undefined) out.top_p = binding.topP;
  if (binding.topK !== undefined) out.top_k = binding.topK;
  if (binding.repetitionPenalty !== undefined) out.repetition_penalty = binding.repetitionPenalty;
  if (binding.maxNewTokens !== undefined) out.max_new_tokens = binding.maxNewTokens;
  return out;
}

/**
 * The synthesis fields of one utterance: the socket's text frame, and (with `model` and
 * `audio_format`) the HTTP body. The streaming example sends `description` and `speaker` in the
 * frame; Rumik's Pipecat plugin also sends the sampling fields there. Whether the socket honours
 * `normalization` is UNCONFIRMED (it is documented on the REST body only).
 */
export function synthesisFields(
  binding: Readonly<RumikTtsBinding>,
  spoken: string,
  voice?: string,
): Record<string, unknown> {
  const speaker = speakerOf(binding, voice);
  const mulberry = modelOf(binding) === 'mulberry';
  return {
    text: spoken,
    ...(mulberry && binding.description ? { description: binding.description } : {}),
    ...(speaker ? { speaker } : {}),
    ...sampling(binding),
    normalization: binding.normalization ?? false,
  };
}

/** `POST /v1/tts/ws-connect`: the model and format are fixed for the socket at mint time. */
export function mintBody(binding: Readonly<RumikTtsBinding>, format: AudioFormat): string {
  return JSON.stringify({
    model: modelOf(binding),
    text: MINT_TEXT,
    audio_format: audioFormatOf(format),
  });
}

export function httpBody(
  binding: Readonly<RumikTtsBinding>,
  spoken: string,
  format: AudioFormat,
  voice?: string,
): string {
  return JSON.stringify({
    model: modelOf(binding),
    audio_format: audioFormatOf(format),
    ...synthesisFields(binding, spoken, voice),
  });
}

/**
 * The billed characters: the text as sent, plus the description on mulberry, which Rumik bills on
 * every request (the docs' example: 7 text + 491 description = 498). An estimate: whether the
 * description is billed per socket frame is UNCONFIRMED.
 */
export function billedCharacters(binding: Readonly<RumikTtsBinding>, spoken: string): number {
  const description = modelOf(binding) === 'mulberry' ? (binding.description ?? '') : '';
  return chars(spoken) + chars(description);
}

/**
 * Every binding field that changes the rendered bytes, defaults resolved, so `{}` and an explicit
 * default share clips. Transport, fallback and timeouts do not change the audio and stay out.
 * Sampling is stochastic (temperature 0.6 to 0.7), so a cached clip is one sample of the voice.
 */
function audioFields(binding: Readonly<RumikTtsBinding>): Record<string, unknown> {
  return {
    speaker: binding.speaker ?? null,
    description: binding.description ?? null,
    defaultTone: binding.defaultTone ?? DEFAULT_TONE,
    sampling: { ...SAMPLING_DEFAULTS, ...sampling(binding) },
    normalization: binding.normalization ?? false,
  };
}

export function cacheRevision(binding: Readonly<RumikTtsBinding>, format: AudioFormat): string {
  const digest = createHash('sha256')
    .update(canonicalJson(audioFields(binding)))
    .digest('hex');
  return `rumik-${format.encoding}-${format.sampleRate}-v1-${digest.slice(0, 16)}`;
}

/** The speech-cache identity: the model, the resolved voice and the audio-field revision. */
export function cacheIdentity(
  binding: Readonly<RumikTtsBinding>,
  format: AudioFormat,
  voice?: string,
): { provider: string; model: string; voice: string; revision: string } {
  return {
    provider: 'rumik',
    model: modelOf(binding),
    voice: voiceOf(binding, voice),
    revision: cacheRevision(binding, format),
  };
}
