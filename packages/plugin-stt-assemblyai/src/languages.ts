import type { AssemblyAiBinding, AssemblyAiModel } from './provider.ts';

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
export const MODEL_LANGUAGES: Readonly<Record<AssemblyAiModel, readonly string[]>> = Object.freeze({
  'universal-streaming-english': ['en'],
  'universal-streaming-multilingual': MULTILINGUAL_LANGUAGES,
  'universal-3-5-pro': PRO_3_5_LANGUAGES,
  'universal-3-6-pro': PRO_3_6_LANGUAGES,
});

export function modelOf(binding: Pick<AssemblyAiBinding, 'model'>): AssemblyAiModel {
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

export function proModel(binding: Pick<AssemblyAiBinding, 'model'>): boolean {
  const model = modelOf(binding);
  return model === 'universal-3-5-pro' || model === 'universal-3-6-pro';
}

function baseLanguage(language: string): string {
  return language.split('-')[0]!.toLowerCase();
}

/**
 * `language_codes` biases the code-switching pro models. Indian callers mix English into Hindi
 * and other Indian languages, so an `-IN` tag also lists English. English alone is the models'
 * default and is not sent, so English bindings keep the handshake they had before this parameter
 * (its JSON-array encoding is not yet confirmed against a live handshake).
 */
export function assemblyAiLanguageCodes(
  binding: Pick<AssemblyAiBinding, 'model'>,
  language: string | undefined,
): string[] | undefined {
  if (!language || !proModel(binding)) return undefined;
  const base = baseLanguage(language);
  if (base === 'en' || !assemblyAiLanguages(binding).includes(base)) return undefined;
  return base !== 'en' && language.toUpperCase().endsWith('-IN') ? [base, 'en'] : [base];
}
