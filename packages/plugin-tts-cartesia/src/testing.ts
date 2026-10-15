import { pcm16ToBytes, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import {
  MULAW_8K,
  type AudioFormat,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';
import { CARTESIA_HOST, CARTESIA_VERSION, outputFormat } from './binding.ts';

const ID = '@winsendotai/ovo-tts-cartesia';
/**
 * Wire shapes, retrieved 2026-10-13:
 * - endpoint, `X-API-Key`, `cartesia_version`, the generation request and the `chunk`,
 *   `flush_done`, `done` and `error` events (examples copied from the AsyncAPI): WS_SOURCE;
 * - `continue`, the empty-transcript end of input and `cancel`: CONTEXTS_SOURCE;
 * - `{transcript: "", continue: true, flush: true}` and the `flush_id` counter: FLUSH_SOURCE;
 * - the error event object and codes: ERRORS_SOURCE.
 * UNCONFIRMED until a live call: whether chunks carry `flush_id` (the guide says so, the schema
 * lists no such field; these fixtures leave it out), what a cancelled context still sends, and the
 * `status_code` of `quota_exceeded` (402 is assumed).
 */
export const WS_SOURCE = 'https://docs.cartesia.ai/api-reference/tts/websocket.md';
export const CONTEXTS_SOURCE = 'https://docs.cartesia.ai/use-the-api/tts-websocket/contexts.md';
export const FLUSH_SOURCE =
  'https://docs.cartesia.ai/use-the-api/tts-websocket/context-flushing-and-flush-i-ds.md';
export const ERRORS_SOURCE = 'https://docs.cartesia.ai/use-the-api/api-errors.md';
export const RETRIEVED = '2026-10-13';

/**
 * Speech-length fixture audio for `text`: a falling two-tone sweep, 55 ms per character and at
 * least a quarter second, in `format`. Distinct per seed so segments can be told apart.
 */
export function sonicAudio(format: AudioFormat, text: string, seed = 1): Uint8Array {
  const ms = Math.max(250, [...text].length * 55);
  const count = Math.round((format.sampleRate * ms) / 1000);
  const pcm = new Int16Array(count);
  const low = 150 + 30 * seed;
  for (let n = 0; n < count; n += 1) {
    const t = n / format.sampleRate;
    const sweep = low + 120 * (1 - n / count);
    pcm[n] = Math.round(
      7000 * Math.sin(2 * Math.PI * sweep * t) + 2000 * Math.sin(2 * Math.PI * 3 * low * t),
    );
  }
  return format.encoding === 'mulaw' ? pcm16ToMulaw(pcm) : pcm16ToBytes(pcm);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export function chunkEvent(contextId: string, audio: Uint8Array): string {
  return JSON.stringify({
    type: 'chunk',
    data: b64(audio),
    done: false,
    status_code: 206,
    step_time: 41,
    context_id: contextId,
  });
}

export function flushDoneEvent(contextId: string, flushId: number): string {
  return JSON.stringify({
    type: 'flush_done',
    done: false,
    flush_done: true,
    flush_id: flushId,
    status_code: 206,
    context_id: contextId,
  });
}

export function doneEvent(contextId: string): string {
  return JSON.stringify({ type: 'done', done: true, status_code: 206, context_id: contextId });
}

export function errorEvent(
  contextId: string | undefined,
  status: number,
  code: string | null,
  title = 'Fixture error',
): string {
  return JSON.stringify({
    type: 'error',
    done: true,
    status_code: status,
    error_code: code,
    title,
    message: `${title} (fixture)`,
    request_id: '550e8400-e29b-41d4-a716-446655440000',
    ...(contextId === undefined ? {} : { context_id: contextId }),
  });
}

export function socketOpen(): NetFixtureStep {
  return {
    expect: 'ws-open',
    url: new RegExp(
      `^wss://api\\.cartesia\\.ai/tts/websocket\\?cartesia_version=${CARTESIA_VERSION}$`,
    ),
    headers: { 'X-API-Key': 'fixture-key' },
  };
}

/** A client frame on `contextId` in `format`, carrying `extra` (subset match). */
export function sent(
  contextId: string,
  format: AudioFormat,
  extra: Record<string, unknown>,
  repeat = false,
): NetFixtureStep {
  const output = outputFormat(format)!;
  return {
    expect: 'ws-send',
    match: 'json',
    where: {
      context_id: contextId,
      'output_format.encoding': output.encoding,
      'output_format.sample_rate': output.sample_rate,
      ...extra,
    },
    ...(repeat ? { repeat: 'until-next' as const } : {}),
  };
}

/** Halves on an odd byte for PCM, so the plugin must re-cut whole samples. */
function halves(audio: Uint8Array, format: AudioFormat): [Uint8Array, Uint8Array] {
  const cut = Math.floor(audio.byteLength / 4) * 2 + (format.encoding === 'pcm_s16le' ? 1 : 0);
  return [audio.subarray(0, cut), audio.subarray(cut)];
}

/** One utterance context: text frames, the empty end-of-input frame, two chunks, `done`. */
export function contextSteps(
  contextId: string,
  text: string,
  format: AudioFormat,
  seed: number,
): NetFixtureStep[] {
  const [first, second] = halves(sonicAudio(format, text, seed), format);
  const spoken = { transcript: /\S/, continue: true, max_buffer_delay_ms: 0 };
  return [
    sent(contextId, format, spoken),
    sent(contextId, format, spoken, true),
    sent(contextId, format, { transcript: '', continue: false }),
    { send: chunkEvent(contextId, first) },
    { send: chunkEvent(contextId, second) },
    { send: doneEvent(contextId) },
  ];
}

/** One reply context: each segment's text and flush, then each segment's audio and flush_done. */
export function replySteps(
  contextId: string,
  texts: readonly string[],
  format: AudioFormat,
): NetFixtureStep[] {
  return [
    ...texts.flatMap((text) => [
      sent(contextId, format, { transcript: `${text} `, continue: true }),
      sent(contextId, format, { transcript: '', continue: true, flush: true }),
    ]),
    ...texts.flatMap((text, index): NetFixtureStep[] => [
      ...halves(sonicAudio(format, text, index + 1), format).map((audio) => ({
        send: chunkEvent(contextId, audio),
      })),
      { send: flushDoneEvent(contextId, index + 1) },
    ]),
  ];
}

const script = (steps: NetFixtureStep[], source = WS_SOURCE): NetFixtureScript => ({
  host: CARTESIA_HOST,
  source,
  retrieved: RETRIEVED,
  steps,
});

/** One pooled socket; agent text N is context `ovo-N`, as a fresh instance numbers them. */
export const cartesiaTtsTemplate: FixtureTemplate = (input) => [
  script([
    socketOpen(),
    ...(input.agentTexts ?? []).flatMap((text, index) =>
      contextSteps(`ovo-${index + 1}`, text, input.format, index + 1),
    ),
  ]),
];

/** Every agent text as the segments of one reply (`openReply`) on context `ovo-1`. */
export const cartesiaReplyTemplate: FixtureTemplate = (input) => [
  script(
    [socketOpen(), ...replySteps('ovo-1', input.agentTexts ?? [], input.format)],
    FLUSH_SOURCE,
  ),
];

/**
 * Barge-in on a two-segment reply: the first chunk plays, the plugin sends `cancel`, and the
 * provider still sends the chunk it was generating ("Any currently generating request will continue
 * sending responses until completion", CONTEXTS_SOURCE) and the flush that ends it. The plugin must
 * drop both: neither may reach a segment.
 */
export function replyBargeIn(
  format: AudioFormat,
  texts: readonly [string, string],
): NetFixtureScript[] {
  const [first, late] = halves(sonicAudio(format, texts[0]), format);
  return [
    script(
      [
        socketOpen(),
        ...texts.flatMap((text) => [
          sent('ovo-1', format, { transcript: `${text} `, continue: true }),
          sent('ovo-1', format, { transcript: '', continue: true, flush: true }),
        ]),
        { send: chunkEvent('ovo-1', first) },
        { expect: 'ws-send', match: 'json', where: { context_id: 'ovo-1', cancel: true } },
        { send: chunkEvent('ovo-1', late) },
        { send: flushDoneEvent('ovo-1', 1) },
      ],
      CONTEXTS_SOURCE,
    ),
  ];
}

/** The provider refuses the first context after its input: `quota_exceeded`, which is final. */
export function quotaRefusal(format: AudioFormat): NetFixtureScript[] {
  return [
    script(
      [
        socketOpen(),
        sent('ovo-1', format, { continue: true }),
        sent('ovo-1', format, { continue: true }, true),
        sent('ovo-1', format, { transcript: '', continue: false }),
        { send: errorEvent('ovo-1', 402, 'quota_exceeded', 'Quota exceeded') },
      ],
      ERRORS_SOURCE,
    ),
  ];
}

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: cartesiaTtsTemplate({
    format: MULAW_8K,
    language: 'en-IN',
    sessionId: 'fixture',
    turns: [],
    agentTexts: ['Hello'],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: cartesiaTtsTemplate };
