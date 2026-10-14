// The contestants still waiting for a key (Deepgram, Sarvam, OpenAI) or a plugin on main
// (Cartesia, Wave 11): wired into the runner, with the options confirmed in their docs.
import { DeepgramStt } from '../../../plugin-stt-deepgram/src/deepgram.ts';
import { OpenAiRealtimeStt } from '../../../plugin-stt-openai-realtime/src/provider.ts';
import { SarvamStt } from '../../../plugin-speech-sarvam/src/stt.ts';
import type { SttConfig } from './config-types.ts';

const RETRIEVED = '2026-10-14';

export const PENDING_CONFIGS: readonly SttConfig[] = [
  {
    id: 'deepgram-nova3-multi',
    label: 'Deepgram Nova-3, language multi',
    provider: 'deepgram',
    model: 'nova-3',
    key: 'DEEPGRAM_API_KEY',
    language: 'multi',
    binding: 'model nova-3, language multi (code-switching incl. Hindi), keyterm Maya',
    create: (net, key) =>
      new DeepgramStt(net, key, { model: 'nova-3', language: 'multi', keyterms: ['Maya'] }),
    price: {
      usdPerHour: 0.552,
      basis: 'audio',
      source: 'https://deepgram.com/pricing',
      retrieved: RETRIEVED,
      note: 'pay-as-you-go list $0.0092/min; a promotion shows $0.0058/min',
    },
    docs: [
      {
        url: 'https://developers.deepgram.com/docs/models-languages-overview',
        retrieved: RETRIEVED,
        confirmed:
          'Nova-3 multi covers English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch; hi is also monolingual.',
      },
      {
        url: 'https://developers.deepgram.com/docs/multilingual-code-switching',
        retrieved: RETRIEVED,
        confirmed:
          'language=multi; results carry `languages` (BCP-47). Keyterm support with multi is not stated.',
      },
    ],
  },
  {
    id: 'deepgram-nova3-en-in',
    label: 'Deepgram Nova-3, en-IN',
    provider: 'deepgram',
    model: 'nova-3',
    key: 'DEEPGRAM_API_KEY',
    language: 'en-IN',
    binding: 'model nova-3, language en-IN, keyterm Maya',
    create: (net, key) =>
      new DeepgramStt(net, key, { model: 'nova-3', language: 'en-IN', keyterms: ['Maya'] }),
    price: {
      usdPerHour: 0.462,
      basis: 'audio',
      source: 'https://deepgram.com/pricing',
      retrieved: RETRIEVED,
      note: 'pay-as-you-go list $0.0077/min; a promotion shows $0.0048/min',
    },
    docs: [
      {
        url: 'https://developers.deepgram.com/docs/models-languages-overview',
        retrieved: RETRIEVED,
        confirmed: 'en-IN is a Nova-3 English variant [unconfirmed on the fetched page].',
      },
    ],
  },
  {
    id: 'sarvam-saaras-v3-codemix',
    label: 'Sarvam saaras:v3-realtime, codemix',
    provider: 'sarvam',
    model: 'saaras:v3-realtime',
    key: 'SARVAM_API_KEY',
    language: 'hi-IN',
    binding: 'model saaras:v3-realtime, mode codemix, hi-IN, provider VAD endpointing',
    create: (net, key) => new SarvamStt(net, key, { mode: 'codemix', languageCode: 'hi-IN' }),
    price: {
      usdPerHour: 30 / 88,
      basis: 'audio',
      source: 'https://docs.sarvam.ai/api/getting-started/pricing (₹30/h at ₹88/USD)',
      retrieved: '2026-10-06',
      note: 'unconfirmed',
    },
    docs: [
      {
        url: 'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming',
        retrieved: RETRIEVED,
        confirmed:
          '/speech-to-text-realtime/ws, model saaras:v3-realtime (default) or saaras:v4, encodings incl. mulaw, stream_type, endpointing vad with silence duration. The older /speech-to-text/ws reference lists saaras:v3/v4 and no mulaw.',
      },
    ],
  },
  {
    id: 'sarvam-saaras-v4-codemix',
    label: 'Sarvam saaras:v4, codemix',
    provider: 'sarvam',
    model: 'saaras:v4',
    key: 'SARVAM_API_KEY',
    language: 'hi-IN',
    binding: 'model saaras:v4, mode codemix, hi-IN',
    create: (net, key) =>
      new SarvamStt(net, key, { model: 'saaras:v4', mode: 'codemix', languageCode: 'hi-IN' }),
    price: {
      usdPerHour: 30 / 88,
      basis: 'audio',
      source: 'https://docs.sarvam.ai/api/getting-started/pricing',
      retrieved: '2026-10-06',
      note: 'unconfirmed for v4',
    },
    docs: [
      {
        url: 'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming',
        retrieved: RETRIEVED,
        confirmed: 'saaras:v4 accepts the same connection parameters as saaras:v3-realtime.',
      },
    ],
  },
  {
    id: 'cartesia-ink2',
    label: 'Cartesia Ink-2 (auto turns endpoint)',
    provider: 'cartesia',
    model: 'ink-2',
    key: 'CARTESIA_API_KEY',
    language: 'en-IN',
    binding: 'wss://api.cartesia.ai/stt/turns/websocket, encoding pcm_mulaw 8000, keyterm Maya',
    price: {
      usdPerHour: 0.41,
      basis: 'audio',
      source: '3 credits/s at $38 per 1M credits (Scale overage); see Wave 11 research',
      retrieved: '2026-10-13',
      note: 'unconfirmed; vendor quotes $0.39/h',
    },
    docs: [
      {
        url: 'https://docs.cartesia.ai/build-with-cartesia/stt/latest',
        retrieved: RETRIEVED,
        confirmed:
          'ink-2 transcribes en, fr, hi, ja, es and detects the language itself (no language parameter). The plugin is in the unmerged Wave 11 PR #11.',
      },
    ],
  },
  {
    id: 'openai-live-transcribe',
    label: 'OpenAI gpt-live-transcribe, auto language',
    provider: 'openai',
    model: 'gpt-live-transcribe',
    key: 'OPENAI_API_KEY',
    language: 'en-IN',
    binding: 'model gpt-live-transcribe, manual commit, no language, keywords Maya',
    create: (net, key) =>
      new OpenAiRealtimeStt(net, key, { model: 'gpt-live-transcribe', keywords: ['Maya'] }),
    price: {
      usdPerHour: 0.36,
      basis: 'audio',
      source: 'https://developers.openai.com/api/docs/pricing',
      retrieved: RETRIEVED,
      note: 'unconfirmed: the realtime transcription guide gives no price',
    },
    docs: [
      {
        url: 'https://developers.openai.com/api/docs/guides/realtime-transcription',
        retrieved: RETRIEVED,
        confirmed:
          'gpt-live-transcribe streams deltas, takes `languages` (plural) and `keywords`, needs turn_detection null (manual commit); no word timestamps or confidence.',
      },
    ],
  },
];
