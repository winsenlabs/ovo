import { pcm16ToBytes, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import {
  MULAW_8K,
  type AudioFormat,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';
import { DEFAULT_MODEL, MINT_TEXT, RUMIK_HOST, audioFormatOf } from './binding.ts';

const ID = '@winsendotai/ovo-tts-rumik';
/**
 * Wire shapes, retrieved 2026-10-13, transcribed from the documentation examples:
 * - STREAMING: mint `POST /v1/tts/ws-connect` → `{ws_url, token, request_id, expires_in}`, connect
 *   to `ws_url?token=`, send `{text, description, speaker}`, read binary chunks until
 *   `{"type":"done","request_id","credits_used"}`; `{"type":"cancel"}` → `{"type":"cancelled",
 *   "request_id","reason":"cancel"}`; `{"type":"timeout"}`; `{"error":true,"code","recoverable"}`.
 * - FORMATS: `audio_format` is set at mint and never repeated in frames; `mulaw` is raw 8 kHz
 *   G.711 μ-law, `pcm` raw 24 kHz mono s16le; `POST /v1/tts` returns the bytes as the body.
 * - MINT: the `WsConnectResponse` example `ws_url` is `wss://silk-api.rumik.ai/ws/tts`.
 * - SYNTHESIS: `POST /v1/tts` response headers `X-Audio-Duration-Ms` and `X-Usage-Cost-Nanos`.
 * UNCONFIRMED until a live call (live.test.ts): how Rumik splits audio across binary frames (the
 * fixtures split it in two), and whether `credits_used` is set on the socket.
 */
export const STREAMING_SOURCE = 'https://docs.rumik.ai/streaming';
export const FORMATS_SOURCE = 'https://docs.rumik.ai/audio-formats';
export const MINT_SOURCE = 'https://docs.rumik.ai/api-reference/speech/create-a-streaming-session';
export const SYNTHESIS_SOURCE = 'https://docs.rumik.ai/api-reference/speech/synthesize-speech';
export const RETRIEVED = '2026-10-13';

export const FIXTURE_KEY = 'fixture-key';
/** The description in the streaming documentation's own example. */
export const FIXTURE_DESCRIPTION =
  'a calm 30s female voice, smooth timbre, slow pacing, like a narrator';
/** The binding every template assumes: the default model (mulberry) needs a description. */
export const FIXTURE_BINDING = Object.freeze({ description: FIXTURE_DESCRIPTION });

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/**
 * Speech-length audio for `text`: a falling tone, 55 ms per character (at least a quarter second),
 * so one text lasts the same in every format while the bytes differ.
 */
export function fixtureAudio(format: AudioFormat, text: string, seed = 1): Uint8Array {
  const duration = Math.max(0.25, [...text].length * 0.055);
  const pcm = new Int16Array(Math.round(format.sampleRate * duration));
  let phase = 0;
  pcm.forEach((_, index) => {
    phase += (2 * Math.PI * (300 + 25 * seed - (index / pcm.length) * 80)) / format.sampleRate;
    pcm[index] = Math.round(8000 * Math.sin(phase));
  });
  return format.encoding === 'mulaw' ? pcm16ToMulaw(pcm) : pcm16ToBytes(pcm);
}

/** Splits audio in two at a whole sample (`odd` splits mid-sample, for alignment tests). */
export function halves(audio: Uint8Array, odd = false): [Uint8Array, Uint8Array] {
  const cut = Math.floor(audio.byteLength / 4) * 2 + (odd ? 1 : 0);
  return [audio.subarray(0, cut), audio.subarray(cut)];
}

export interface MintOptions {
  token?: string;
  wsUrl?: string;
  expiresIn?: number;
  model?: string;
  status?: number;
  delayMs?: number;
}

/** The `POST /v1/tts/ws-connect` step and its reply. */
export function mintSteps(format: AudioFormat, options: MintOptions = {}): NetFixtureStep[] {
  const status = options.status ?? 200;
  return [
    {
      expect: 'http',
      method: 'POST',
      url: `https://${RUMIK_HOST}/v1/tts/ws-connect`,
      headers: { authorization: `Bearer ${FIXTURE_KEY}` },
      body: 'json',
      where: {
        model: options.model ?? DEFAULT_MODEL,
        text: MINT_TEXT,
        audio_format: audioFormatOf(format),
      },
      reply:
        status === 200
          ? {
              status,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                ws_url: options.wsUrl ?? `wss://${RUMIK_HOST}/ws/tts`,
                token: options.token ?? 'tok-1',
                request_id: `req_mint_${options.token ?? 'tok-1'}`,
                expires_in: options.expiresIn ?? 300,
              }),
            }
          : { status, body: JSON.stringify({ error: 'refused', code: `HTTP_${status}` }) },
    },
    ...(options.delayMs ? [{ delayMs: options.delayMs }] : []),
  ];
}

export function socketOpen(token = 'tok-1'): NetFixtureStep {
  return {
    expect: 'ws-open',
    url: new RegExp(`^wss://${escape(RUMIK_HOST)}/ws/tts\\?token=${escape(token)}$`),
  };
}

export const doneFrame = (requestId: string, characters = 0) =>
  JSON.stringify({ type: 'done', request_id: requestId, credits_used: characters });

/** One generation: the text frame, the audio in two binary frames, then `done`. */
export function generationSteps(
  text: string,
  format: AudioFormat,
  seed: number,
  where: Record<string, unknown> = { description: FIXTURE_DESCRIPTION, normalization: false },
): NetFixtureStep[] {
  const [first, second] = halves(fixtureAudio(format, text, seed));
  return [
    { expect: 'ws-send', match: 'json', where: { text, ...where } },
    { send: { base64: base64(first) } },
    { send: { base64: base64(second) } },
    { send: doneFrame(`req_gen_${seed}`, [...text].length + FIXTURE_DESCRIPTION.length) },
  ];
}

/**
 * One minted socket for the session; agent text N is the Nth generation on it, in order. A reply
 * (`openReply`) renders exactly the same frames: its segments are generations on the same queue.
 */
export const rumikTtsTemplate: FixtureTemplate = (input): NetFixtureScript[] => [
  {
    host: RUMIK_HOST,
    source: STREAMING_SOURCE,
    retrieved: RETRIEVED,
    steps: [
      ...mintSteps(input.format),
      socketOpen(),
      ...(input.agentTexts ?? []).flatMap((text, index) =>
        generationSteps(text, input.format, index + 1),
      ),
    ],
  },
];

/** The `POST /v1/tts` path (fallback or `transport: 'http'`): one request per agent text. */
export const rumikHttpTemplate: FixtureTemplate = (input): NetFixtureScript[] =>
  (input.agentTexts ?? []).map((text, index) => ({
    host: RUMIK_HOST,
    source: SYNTHESIS_SOURCE,
    retrieved: RETRIEVED,
    steps: [synthesisStep(text, input.format, fixtureAudio(input.format, text, index + 1))],
  }));

/** One `POST /v1/tts` answered 200 with `audio` in two chunks split mid-sample. */
export function synthesisStep(
  text: string,
  format: AudioFormat,
  audio: Uint8Array,
  headers: Record<string, string> = {},
): NetFixtureStep {
  const [first, second] = halves(audio, true);
  return {
    expect: 'http',
    method: 'POST',
    url: `https://${RUMIK_HOST}/v1/tts`,
    headers: { authorization: `Bearer ${FIXTURE_KEY}` },
    body: 'json',
    where: { text, audio_format: audioFormatOf(format) },
    reply: {
      status: 200,
      headers: {
        'content-type':
          format.encoding === 'mulaw'
            ? 'audio/x-mulaw; rate=8000; channels=1'
            : 'audio/pcm; rate=24000; channels=1; format=s16le',
        ...headers,
      },
      chunks: [{ base64: base64(first) }, { base64: base64(second) }],
    },
  } as NetFixtureStep;
}

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: rumikTtsTemplate({
    format: MULAW_8K,
    language: 'hi-IN',
    sessionId: 'fixture',
    turns: [],
    agentTexts: ['Namaste, main aapki kaise madad kar sakti hoon?'],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: rumikTtsTemplate };
