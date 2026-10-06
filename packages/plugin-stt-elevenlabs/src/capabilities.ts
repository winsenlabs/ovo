import { MULAW_8K, PCM16_16K, PCM16_8K } from '@winsendotai/ovo-contracts';
import type { ElevenLabsSttBinding } from './provider.ts';

// BCP-47 base subtags (ISO 639-1 where one exists) of the Scribe v2 languages, which the realtime
// model shares. Source:
// https://elevenlabs.io/docs/capabilities/speech-to-text#supported-languages (retrieved 2026-10-06).
const SCRIBE_LANGUAGES = [
  ...['af', 'am', 'ar', 'as', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el'],
  ...['en', 'es', 'et', 'fa', 'ff', 'fi', 'fil', 'fr', 'ga', 'gl', 'gu', 'ha', 'he', 'hi', 'hr'],
  ...['hu', 'hy', 'id', 'ig', 'is', 'it', 'ja', 'jv', 'ka', 'kk', 'km', 'kn', 'ko', 'ku', 'ky'],
  ...['lb', 'lg', 'ln', 'lo', 'lt', 'lv', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne'],
  ...['nl', 'no', 'nso', 'ny', 'oc', 'or', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sd', 'si', 'sk'],
  ...['sl', 'sn', 'so', 'sr', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tr', 'uk', 'ur', 'uz', 'vi'],
  ...['wo', 'xh', 'yo', 'yue', 'zh', 'zu', 'ast', 'ceb', 'kea', 'luo'],
];

export const SCRIBE_CAPABILITIES = Object.freeze({
  // Mu-law first: Twilio's native format reaches the provider without a transcode.
  inputFormats: [MULAW_8K, PCM16_8K, PCM16_16K],
  // Host compat compares the full release language; these are the tags OVO agents use.
  languages: ['en', 'en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'bn-IN'],
  // Base language codes per binding model, for the host compat check that reads the binding.
  bindingLanguages: {
    field: 'model',
    default: 'scribe_v2_realtime',
    by: { scribe_v2_realtime: SCRIBE_LANGUAGES },
  },
  interim: true,
  wordTimestamps: false,
  // Manual commit: a final and its end-of-turn follow only a host commit, so a release must
  // select a VAD (local endpointing) rather than rely on provider turn signals.
  turnSignals: [] as readonly ('end-of-turn' | 'speech-start')[],
  forceEndpoint: true,
  ttfsP99Ms: 600,
});

/** The binding-aware capability set: provider commits announce their own end of turn. */
export function scribeCapabilitiesFor(binding: Pick<ElevenLabsSttBinding, 'commitStrategy'>) {
  return {
    ...SCRIBE_CAPABILITIES,
    turnSignals: binding.commitStrategy === 'vad' ? (['end-of-turn'] as const) : [],
  };
}

export function baseLanguage(language: string): string {
  return language.split('-')[0]!.toLowerCase();
}

export function scribeSupportsLanguage(language: string): boolean {
  return SCRIBE_LANGUAGES.includes(baseLanguage(language));
}
