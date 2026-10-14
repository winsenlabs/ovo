// The contestants with keys in Wave 13: ElevenLabs Scribe v2 realtime and AssemblyAI streaming,
// with the options confirmed in their docs.
import type { NetPort } from '../../../contracts/src/index.ts';
import { AssemblyAiStt } from '../../../plugin-stt-assemblyai/src/provider.ts';
import { ElevenLabsStt } from '../../../plugin-stt-elevenlabs/src/provider.ts';
import type { Price, SttConfig } from './config-types.ts';

/** Terms a European-travel agent would configure: its name, the caller's and the places. */
export const TRAVEL_KEYTERMS = [
  'Maya',
  'Tejas',
  'Zagreb',
  'Croatia',
  'Budapest',
  'Vienna',
  'Prague',
  'Berlin',
  'Frankfurt',
  'Brandenburg Gate',
  'Brandenburger Tor',
  'Balkans',
  'Hungary',
  'Austria',
  'Chennai',
];

const RETRIEVED = '2026-10-14';
const SCRIBE_DOCS = {
  url: 'https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime',
  retrieved: RETRIEVED,
  confirmed:
    'language_code (ISO 639-1/639-3) pins; omitted, the model detects; secondary_languages; keyterms; include_language_detection adds language_code to committed_transcript_with_timestamps; commit_strategy manual | vad | turn_prediction; audio_format ulaw_8000. Code-switching is not documented.',
};
const SCRIBE_PRICE: Price = {
  usdPerHour: 0.39,
  basis: 'audio',
  source: 'https://elevenlabs.io/pricing/api (Scribe v2 Realtime)',
  retrieved: RETRIEVED,
};
const SCRIBE_KEYTERM_PRICE: Price = {
  ...SCRIBE_PRICE,
  usdPerHour: 0.39 + 0.08,
  note: 'keyterm prompting is billed at +$0.08/h',
};
const AAI_DOCS = {
  url: 'https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api',
  retrieved: RETRIEVED,
  confirmed:
    'speech_model universal-3-6-pro | universal-3-5-pro | universal-streaming-english | universal-streaming-multilingual; encoding pcm_mulaw; language_codes steers code-switching; language_detection adds language_code to Turn; keyterms_prompt up to 100 terms.',
};
const AAI_LANGUAGES_DOCS = {
  url: 'https://www.assemblyai.com/docs/streaming/multilingual-transcription',
  retrieved: RETRIEVED,
  confirmed:
    'Only Universal-3.6 Pro streaming code-switches with Hindi; Universal-Streaming Multilingual covers en, es, de, fr, pt, it; language_codes ["en","hi"] biases toward English-Hindi.',
};
const AAI_PRICE = 'https://www.assemblyai.com/pricing';

/**
 * Scribe bindings share the production plugin defaults (manual commit, word confidence) and ask
 * for language detection, which only adds the detected language to each commit's word message.
 */
function scribe(binding: object, agentName?: string) {
  return (net: NetPort, key: string) =>
    new ElevenLabsStt(
      net,
      key,
      { commitStrategy: 'manual', languageDetection: true, ...binding },
      undefined,
      agentName ? { agentName } : {},
    );
}

export const KEYED_CONFIGS: readonly SttConfig[] = [
  {
    id: 'scribe-auto',
    label: 'Scribe v2 realtime, auto language (production)',
    provider: 'elevenlabs',
    model: 'scribe_v2_realtime',
    key: 'ELEVENLABS_API_KEY',
    language: 'en-IN',
    binding: 'languageMode auto, manual commit, keyterm Maya (agent name)',
    production: true,
    create: scribe({ languageMode: 'auto' }, 'Maya'),
    price: SCRIBE_KEYTERM_PRICE,
    docs: [SCRIBE_DOCS],
  },
  {
    id: 'scribe-en',
    label: 'Scribe v2 realtime, pinned en',
    provider: 'elevenlabs',
    model: 'scribe_v2_realtime',
    key: 'ELEVENLABS_API_KEY',
    language: 'en-IN',
    binding: 'languageMode session (en), manual commit, keyterm Maya',
    create: scribe({ languageMode: 'session', sessionLanguage: 'en' }, 'Maya'),
    price: SCRIBE_KEYTERM_PRICE,
    docs: [SCRIBE_DOCS],
  },
  {
    id: 'scribe-hi',
    label: 'Scribe v2 realtime, pinned hi',
    provider: 'elevenlabs',
    model: 'scribe_v2_realtime',
    key: 'ELEVENLABS_API_KEY',
    language: 'en-IN',
    binding: 'languageMode session (hi), manual commit, keyterm Maya',
    create: scribe({ languageMode: 'session', sessionLanguage: 'hi' }, 'Maya'),
    price: SCRIBE_KEYTERM_PRICE,
    docs: [SCRIBE_DOCS],
  },
  {
    id: 'scribe-en-hi',
    label: 'Scribe v2 realtime, en with secondary hi',
    provider: 'elevenlabs',
    model: 'scribe_v2_realtime',
    key: 'ELEVENLABS_API_KEY',
    language: 'en-IN',
    binding: 'languageMode session (en), secondaryLanguages [hi], manual commit, keyterm Maya',
    create: scribe(
      { languageMode: 'session', sessionLanguage: 'en', secondaryLanguages: ['hi'] },
      'Maya',
    ),
    price: SCRIBE_KEYTERM_PRICE,
    docs: [SCRIBE_DOCS],
  },
  {
    id: 'scribe-en-keyterms',
    label: 'Scribe v2 realtime, pinned en + travel keyterms',
    provider: 'elevenlabs',
    model: 'scribe_v2_realtime',
    key: 'ELEVENLABS_API_KEY',
    language: 'en-IN',
    binding: `languageMode session (en), manual commit, keyterms ${TRAVEL_KEYTERMS.join(', ')}`,
    create: scribe({
      languageMode: 'session',
      sessionLanguage: 'en',
      keyterms: TRAVEL_KEYTERMS,
    }),
    price: SCRIBE_KEYTERM_PRICE,
    docs: [SCRIBE_DOCS],
  },
  {
    id: 'aai-english',
    label: 'AssemblyAI Universal-Streaming English',
    provider: 'assemblyai',
    model: 'universal-streaming-english',
    key: 'ASSEMBLYAI_API_KEY',
    language: 'en-IN',
    binding: 'model universal-streaming-english, keyterms Maya',
    create: (net, key) =>
      new AssemblyAiStt(net, key, { model: 'universal-streaming-english', keyterms: ['Maya'] }),
    price: {
      usdPerHour: 0.15 + 0.04,
      basis: 'session',
      source: AAI_PRICE,
      retrieved: RETRIEVED,
      note: 'billed on WebSocket session duration; keyterms +$0.04/h',
    },
    docs: [AAI_DOCS],
  },
  {
    id: 'aai-multilingual',
    label: 'AssemblyAI Universal-Streaming Multilingual',
    provider: 'assemblyai',
    model: 'universal-streaming-multilingual',
    key: 'ASSEMBLYAI_API_KEY',
    language: 'en-IN',
    binding: 'model universal-streaming-multilingual (no Hindi), keyterms Maya',
    create: (net, key) =>
      new AssemblyAiStt(net, key, {
        model: 'universal-streaming-multilingual',
        keyterms: ['Maya'],
      }),
    price: {
      usdPerHour: 0.15,
      basis: 'session',
      source: AAI_PRICE,
      retrieved: RETRIEVED,
      note: 'billed on WebSocket session duration; keyterms included',
    },
    docs: [AAI_DOCS, AAI_LANGUAGES_DOCS],
  },
  {
    id: 'aai-u3pro-hi-en',
    label: 'AssemblyAI Universal-3.6 Pro streaming, language_codes hi+en',
    provider: 'assemblyai',
    model: 'universal-3-6-pro',
    key: 'ASSEMBLYAI_API_KEY',
    // An hi-IN session makes the plugin send language_codes ["hi","en"] (code-switching).
    language: 'hi-IN',
    binding: 'model universal-3-6-pro, session hi-IN (language_codes ["hi","en"]), keyterms Maya',
    create: (net, key) =>
      new AssemblyAiStt(net, key, { model: 'universal-3-6-pro', keyterms: ['Maya'] }),
    price: {
      usdPerHour: 0.45,
      basis: 'session',
      source: AAI_PRICE,
      retrieved: RETRIEVED,
      note: 'billed on WebSocket session duration; keyterms included',
    },
    docs: [AAI_DOCS, AAI_LANGUAGES_DOCS],
  },
];
