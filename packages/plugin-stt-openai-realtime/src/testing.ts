import {
  MULAW_8K,
  type FixtureTemplate,
  type FixtureTemplateInput,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';

const ID = '@winsendotai/ovo-stt-openai-realtime';
export const SOURCE =
  'https://developers.openai.com/api/reference/resources/realtime/server-events';
export const RETRIEVED = '2026-10-06';

/** The documented server events (examples in the server-events reference), trimmed to the fields read. */
export function sessionCreated(id = 'sess_fixture'): string {
  return JSON.stringify({
    type: 'session.created',
    event_id: 'event_created',
    session: { id, object: 'realtime.transcription_session', type: 'transcription' },
  });
}

export function sessionUpdated(): string {
  return JSON.stringify({
    type: 'session.updated',
    event_id: 'event_updated',
    session: { type: 'transcription' },
  });
}

export function committed(itemId: string, previous: string | null = null): string {
  return JSON.stringify({
    type: 'input_audio_buffer.committed',
    event_id: `event_committed_${itemId}`,
    previous_item_id: previous,
    item_id: itemId,
  });
}

export function delta(itemId: string, text: string): string {
  return JSON.stringify({
    type: 'conversation.item.input_audio_transcription.delta',
    event_id: `event_delta_${itemId}`,
    item_id: itemId,
    content_index: 0,
    delta: text,
  });
}

export function completed(itemId: string, transcript: string): string {
  return JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    event_id: `event_completed_${itemId}`,
    item_id: itemId,
    content_index: 0,
    transcript,
  });
}

const OPEN: NetFixtureStep = {
  expect: 'ws-open',
  url: 'wss://api.openai.com/v1/realtime?intent=transcription',
  headers: { authorization: 'Bearer fixture-key' },
};

const UPDATE: NetFixtureStep = {
  expect: 'ws-send',
  match: 'json',
  where: { type: 'session.update' },
};

const AUDIO: NetFixtureStep = {
  expect: 'ws-send',
  match: 'json',
  where: { type: 'input_audio_buffer.append' },
  repeat: 'until-next',
};

/** Any later client event: audio, and a commit nothing answers (a finish after a forced one). */
const TAIL: NetFixtureStep = { expect: 'ws-send', match: 'json', repeat: 'until-next' };

/** One caller turn: audio with streamed deltas, then the host's commit and the final transcript. */
function turn(say: string, index: number): NetFixtureStep[] {
  const item = `item_${String(index + 1).padStart(3, '0')}`;
  const words = say.split(' ');
  return [
    AUDIO,
    { send: delta(item, words.slice(0, 2).join(' ')) },
    {
      expect: 'ws-send',
      match: 'json',
      where: { type: 'input_audio_buffer.commit' },
    },
    { send: committed(item) },
    ...(words.length > 2 ? [{ send: delta(item, ` ${words.slice(2).join(' ')}`) }] : []),
    { send: completed(item, say) },
  ];
}

/**
 * The documented manual-commit sequence: session.created, the client's session.update and its
 * session.updated, appended audio with transcript deltas, then input_audio_buffer.commit answered
 * by input_audio_buffer.committed and the completed transcript.
 */
export const realtimeSttTemplate: FixtureTemplate = ({ turns }) => [
  {
    host: 'api.openai.com',
    source: SOURCE,
    retrieved: RETRIEVED,
    steps: [
      OPEN,
      { send: sessionCreated() },
      UPDATE,
      { send: sessionUpdated() },
      ...turns.flatMap((entry, index) => (entry.say ? turn(entry.say, index) : [])),
      TAIL,
    ],
  },
];

export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: realtimeSttTemplate };

/** One English utterance, the shape the distribution's fixture profile replays. */
const HELLO: FixtureTemplateInput = {
  format: MULAW_8K,
  language: 'en',
  sessionId: 'fixture',
  turns: [{ atMs: 0, say: 'hello there' }],
};
export const fixtures: Record<string, NetFixtureScript[]> = { [ID]: realtimeSttTemplate(HELLO) };
