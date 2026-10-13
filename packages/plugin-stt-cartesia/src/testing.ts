import {
  MULAW_8K,
  type AudioFormat,
  type FixtureTemplate,
  type FixtureTemplateInput,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';
import { AUTO_PATH, CARTESIA_HOST, CARTESIA_VERSION, MANUAL_PATH, encodingOf } from './wire.ts';

export const AUTO_ID = '@winsendotai/ovo-stt-cartesia';
export const MANUAL_ID = '@winsendotai/ovo-stt-cartesia-manual';
/**
 * Wire shapes, retrieved 2026-10-13. Event examples are copied from the AsyncAPI references
 * (AUTO_SOURCE, MANUAL_SOURCE); the request id is the one those examples use.
 * UNCONFIRMED until a live call: that `flush_done` follows every `is_final` chunk its `finalize`
 * produced, the `language` field on finals (the example has it, the schema does not), and what the
 * turns endpoint sends after `{"type":"close"}` besides the remaining turn events.
 */
export const AUTO_SOURCE = 'https://docs.cartesia.ai/api-reference/stt/turns/websocket.md';
export const MANUAL_SOURCE = 'https://docs.cartesia.ai/api-reference/stt/websocket.md';
export const RETRIEVED = '2026-10-13';
const REQUEST_ID = '2ff8af53-4d38-479d-8287-58940f01c701';

const event = (type: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ type, ...fields, request_id: REQUEST_ID });

export const connectedEvent = () => event('connected');
export const turnEvent = (type: string, transcript?: string) =>
  event(type, transcript === undefined ? {} : { transcript });

/** A manual transcript; finals carry word timestamps (illustrative times, 0.35 s per word). */
export function transcriptEvent(text: string, isFinal: boolean, atSecond = 0): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return event('transcript', {
    is_final: isFinal,
    text,
    ...(isFinal
      ? {
          duration: words.length * 0.35,
          language: 'en',
          words: words.map((word, i) => ({
            word,
            start: atSecond + i * 0.35,
            end: atSecond + i * 0.35 + 0.3,
          })),
        }
      : {}),
  });
}

export const flushDoneEvent = () => event('flush_done');
export const doneEvent = () => event('done');
export const errorEvent = (status: number, code: string | null, title = 'Fixture error') =>
  event('error', { title, message: `${title} (fixture)`, error_code: code, status_code: status });

/** Binary audio frames, as many as the session sends until the next expected frame. */
export const AUDIO: NetFixtureStep = { expect: 'ws-send', match: 'binary', repeat: 'until-next' };

/**
 * A bare text command (`finalize`, `close`). Exact text frames need plugin-kit's `match: 'any'`
 * with `where.text` (requested from the wiring lane); see tests/conformance.test.ts.
 */
export const textCommand = (text: string | RegExp): NetFixtureStep => ({
  expect: 'ws-send',
  match: 'any',
  where: { text },
});

export function socketOpen(path: string, format: AudioFormat, model = 'ink-2'): NetFixtureStep {
  const prefix = `wss://api.cartesia.ai${path}?model=${model}&encoding=${encodingOf(format)}&sample_rate=${format.sampleRate}&cartesia_version=${CARTESIA_VERSION}`;
  return {
    expect: 'ws-open',
    url: new RegExp(`^${prefix.replace(/[.?]/g, (c) => `\\${c}`)}(?:&|$)`),
    headers: { 'X-API-Key': 'fixture-key' },
  };
}

const firstWords = (say: string) => say.split(' ').slice(0, 2).join(' ');

/** One caller turn on the turns endpoint: audio, start, a cumulative update, eager end, end. */
function autoTurn(say: string): NetFixtureStep[] {
  return [
    AUDIO,
    { send: turnEvent('turn.start') },
    { send: turnEvent('turn.update', firstWords(say)) },
    { send: turnEvent('turn.eager_end', say) },
    { send: turnEvent('turn.end', say) },
  ];
}

/** One caller utterance on the manual endpoint: an interim, then finalize answered by two deltas. */
function manualTurn(say: string): NetFixtureStep[] {
  const words = say.split(' ');
  const head = words.slice(0, Math.ceil(words.length / 2)).join(' ');
  const tail = say.slice(head.length);
  return [
    AUDIO,
    { send: transcriptEvent(firstWords(say), false) },
    textCommand('finalize'),
    { send: transcriptEvent(head, true) },
    // A delta keeps its leading space: deltas are concatenated verbatim [doc].
    { send: transcriptEvent(tail, true, 0.35 * Math.ceil(words.length / 2)) },
    { send: flushDoneEvent() },
  ];
}

const script = (source: string, steps: NetFixtureStep[]): NetFixtureScript => ({
  host: CARTESIA_HOST,
  source,
  retrieved: RETRIEVED,
  steps,
});

/**
 * The turns endpoint: `connected`, each turn's events after its first audio, then the
 * session's `{"type":"close"}` answered by the provider closing the socket.
 */
export const cartesiaAutoTemplate: FixtureTemplate = ({ format, turns }) => [
  script(AUTO_SOURCE, [
    socketOpen(AUTO_PATH, format),
    { send: connectedEvent() },
    ...turns.flatMap((turn) => (turn.say ? autoTurn(turn.say) : [])),
    AUDIO,
    { expect: 'ws-send', match: 'json', where: { type: 'close' } },
    { close: { code: 1000 } },
  ]),
];

/**
 * The manual endpoint: each utterance is finalized (by the host's endpoint, or by `finish`);
 * the last command is `close` (or the finish's own `finalize`), answered by `done` and a close.
 */
export const cartesiaManualTemplate: FixtureTemplate = ({ format, turns }) => [
  script(MANUAL_SOURCE, [
    socketOpen(MANUAL_PATH, format),
    ...turns.flatMap((turn) => (turn.say ? manualTurn(turn.say) : [])),
    AUDIO,
    textCommand(/^(?:close|finalize)$/),
    { send: doneEvent() },
    { close: { code: 1000 } },
  ]),
];

const HELLO: FixtureTemplateInput = {
  format: MULAW_8K,
  language: 'en',
  sessionId: 'fixture',
  turns: [{ atMs: 0, say: 'hello there' }],
};

export const fixtureTemplates: Record<string, FixtureTemplate> = {
  [AUTO_ID]: cartesiaAutoTemplate,
  [MANUAL_ID]: cartesiaManualTemplate,
};
export const fixtures: Record<string, NetFixtureScript[]> = {
  [AUTO_ID]: cartesiaAutoTemplate(HELLO),
  [MANUAL_ID]: cartesiaManualTemplate(HELLO),
};
