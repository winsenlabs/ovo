import { pcm16ToBytes, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import {
  MULAW_8K,
  type AudioFormat,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';
import { DEFAULT_MODEL, outputFormat } from './binding.ts';

const ID = '@winsendotai/ovo-tts-elevenlabs';
const HOST = 'api.elevenlabs.io';
/**
 * Wire shapes, retrieved 2026-10-06:
 * - endpoint, query parameters, `xi-api-key` header and message schemas: WS_SOURCE;
 * - flush / close_context / 5-context limit / interruption: GUIDE;
 * - `{text: "", flush: true}` then `close_context` at end of input, `contextId` or `context_id`
 *   on replies, `isFinal`: LiveKit's production plugin (LIVEKIT), which the docs leave unstated.
 * UNCONFIRMED until a live call: that the first text frame of a context may carry real text with
 * `voice_settings` and `pronunciation_dictionary_locators` (the cookbook shows voice_settings only),
 * and the exact shape of error frames (`{error, message}` is assumed).
 */
export const WS_SOURCE =
  'https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input';
export const GUIDE =
  'https://elevenlabs.io/docs/developers/guides/cookbooks/multi-context-web-socket';
export const LIVEKIT =
  'https://github.com/livekit/agents/blob/main/livekit-plugins/livekit-plugins-elevenlabs/livekit/plugins/elevenlabs/tts.py';
/** Body fields and `output_format` values. Response headers are not documented there. */
export const HTTP_SOURCE = 'https://elevenlabs.io/docs/api-reference/text-to-speech/stream';
/** The `request-id` and `character-cost` response headers. */
export const CHARACTER_COST_SOURCE = 'https://elevenlabs.io/docs/api-reference/introduction';
export const RETRIEVED = '2026-10-06';

const SPOKEN = /\S/;

/** Speech-length audio for `text` in `format`: a tone of about 60 ms per character. */
export function fixtureAudio(format: AudioFormat, text: string, seed = 1): Uint8Array {
  const ms = Math.max(240, [...text].length * 60);
  const samples = Math.round((format.sampleRate * ms) / 1000);
  const pcm = new Int16Array(samples);
  const hz = 180 + 40 * seed;
  for (let i = 0; i < samples; i += 1)
    pcm[i] = Math.round(9000 * Math.sin((2 * Math.PI * hz * i) / format.sampleRate));
  return format.encoding === 'mulaw' ? pcm16ToMulaw(pcm) : pcm16ToBytes(pcm);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/** Client and server frames of one context: text, flush, close, two audio frames, isFinal. */
export function contextSteps(
  contextId: string,
  text: string,
  format: AudioFormat,
  seed: number,
): NetFixtureStep[] {
  const audio = fixtureAudio(format, text, seed);
  const half = Math.floor(audio.byteLength / 4) * 2;
  return [
    { expect: 'ws-send', match: 'json', where: { context_id: contextId, text: SPOKEN } },
    {
      expect: 'ws-send',
      match: 'json',
      where: { context_id: contextId, text: SPOKEN },
      repeat: 'until-next',
    },
    { expect: 'ws-send', match: 'json', where: { context_id: contextId, text: '', flush: true } },
    { expect: 'ws-send', match: 'json', where: { context_id: contextId, close_context: true } },
    { send: JSON.stringify({ audio: base64(audio.subarray(0, half)), contextId }) },
    { send: JSON.stringify({ audio: base64(audio.subarray(half)), contextId }) },
    { send: JSON.stringify({ isFinal: true, contextId }) },
  ];
}

export function socketOpen(format: AudioFormat, voice = '[^/?]+'): NetFixtureStep {
  return {
    expect: 'ws-open',
    url: new RegExp(
      `^wss://api\\.elevenlabs\\.io/v1/text-to-speech/${voice}/multi-stream-input\\?model_id=[\\w.]+&output_format=${outputFormat(format)}&`,
    ),
    headers: { 'xi-api-key': 'fixture-key' },
  };
}

/** One pooled socket; agent text N is context `ovo-N`, as a fresh plugin instance numbers them. */
export const elevenLabsTtsTemplate: FixtureTemplate = (input): NetFixtureScript[] => [
  {
    host: HOST,
    source: WS_SOURCE,
    retrieved: RETRIEVED,
    steps: [
      socketOpen(input.format),
      ...(input.agentTexts ?? []).flatMap((text, index) =>
        contextSteps(`ovo-${index + 1}`, text, input.format, index + 1),
      ),
    ],
  },
];

/** The HTTP stream path (fallback or `transport: 'http'`): one POST per agent text. */
export const elevenLabsHttpTemplate: FixtureTemplate = (input): NetFixtureScript[] =>
  (input.agentTexts ?? []).map((text, index) => {
    const audio = fixtureAudio(input.format, text, index + 1);
    const half = Math.floor(audio.byteLength / 4) * 2 + 1;
    return {
      host: HOST,
      source: HTTP_SOURCE,
      retrieved: RETRIEVED,
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: new RegExp(
            `^https://api\\.elevenlabs\\.io/v1/text-to-speech/[^/?]+/stream\\?output_format=${outputFormat(input.format)}$`,
          ),
          headers: { 'xi-api-key': 'fixture-key' },
          body: 'json',
          where: { text, model_id: DEFAULT_MODEL },
          reply: {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
            // An odd split, so PCM callers must re-cut whole samples.
            chunks: [
              { base64: base64(audio.subarray(0, half)) },
              { base64: base64(audio.subarray(half)) },
            ],
          },
        } as NetFixtureStep,
      ],
    };
  });

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: elevenLabsTtsTemplate({
    format: MULAW_8K,
    language: 'en-IN',
    sessionId: 'fixture',
    turns: [],
    agentTexts: ['Hello'],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: elevenLabsTtsTemplate };
