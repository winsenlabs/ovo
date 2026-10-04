import {
  MULAW_8K,
  sameFormat,
  type SpeechCapabilities,
  type StreamingTts,
  type TextToSpeech,
  type UsageSink,
} from '@winsendotai/ovo-contracts';

export interface LegacyTtsIdentity {
  provider: string;
  model: string;
  /** Used when a request names no voice. */
  voice: string;
  /** Cache revision for MULAW_8K, e.g. 'openai-tts-mulaw-8000-v1'. */
  revision: string;
}

/** v1 → v2 TTS (§2.11). A v1 TTS emits μ-law 8 kHz only, so that is its only native format. */
export function legacyAsTts(
  v1: StreamingTts,
  identity: LegacyTtsIdentity,
  options: { capabilities?: Partial<SpeechCapabilities> } = {},
): TextToSpeech {
  const capabilities: SpeechCapabilities = Object.freeze({
    outputFormats: Object.freeze([MULAW_8K]),
    languages: Object.freeze(['*']),
    interim: false,
    wordTimestamps: false,
    turnSignals: Object.freeze([]),
    forceEndpoint: false,
    ...options.capabilities,
  });
  return {
    capabilities,
    cacheIdentity(_format, voice) {
      return {
        provider: identity.provider,
        model: identity.model,
        voice: voice ?? identity.voice,
        revision: identity.revision,
      };
    },
    synthesize(input) {
      if (!sameFormat(input.format, MULAW_8K))
        throw new TypeError('A v1 TTS emits only MULAW_8K; the host adapter transcodes');
      return v1.synthesize({
        sessionId: input.sessionId,
        text: input.text,
        codec: 'audio/x-mulaw',
        sampleRate: 8000,
        ...(input.voice === undefined ? {} : { voice: input.voice }),
        signal: input.signal,
      });
    },
  };
}

/** v2 → v1 TTS (§2.11): requests MULAW_8K; the v2 plugin (or host adapter) must provide it. */
export function ttsAsLegacy(
  v2: TextToSpeech,
  options: { language?: string; onUsage?: UsageSink } = {},
): StreamingTts {
  return {
    synthesize(input) {
      return v2.synthesize({
        sessionId: input.sessionId,
        text: input.text,
        format: MULAW_8K,
        language: options.language ?? 'en',
        ...(input.voice === undefined ? {} : { voice: input.voice }),
        signal: input.signal,
        onUsage: options.onUsage ?? (() => undefined),
      });
    },
  };
}
