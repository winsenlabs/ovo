import {
  MULAW_8K,
  type FixtureTemplate,
  type FixtureTemplateInput,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';

const ID = '@winsendotai/ovo-stt-elevenlabs';
export const SOURCE =
  'https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime';
export const RETRIEVED = '2026-10-06';

export function sessionStarted(id = 'scribe-fixture-session'): string {
  return JSON.stringify({
    message_type: 'session_started',
    session_id: id,
    config: {
      model_id: 'scribe_v2_realtime',
      audio_format: 'ulaw_8000',
      commit_strategy: 'manual',
    },
  });
}

export function partial(text: string): string {
  return JSON.stringify({ message_type: 'partial_transcript', text });
}

export function committed(text: string): string {
  return JSON.stringify({ message_type: 'committed_transcript', text });
}

/**
 * The word-level message the provider sends after a commit with `include_timestamps` (the
 * default binding asks for it): each word with its `logprob`, -0.05 unless given. Shape from
 * https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime (retrieved
 * 2026-10-08); the log probabilities are illustrative, not recorded.
 */
export function committedWords(
  text: string,
  logprobs: readonly number[] = [],
  language: string | null = null,
): string {
  const words = text.split(/\s+/).filter(Boolean);
  return JSON.stringify({
    message_type: 'committed_transcript_with_timestamps',
    text,
    language_code: language,
    words: words.flatMap((word, i) => [
      ...(i ? [{ text: ' ', start: i * 0.4, end: i * 0.4, type: 'spacing', logprob: 0 }] : []),
      {
        text: word,
        start: i * 0.4,
        end: i * 0.4 + 0.35,
        type: 'word',
        logprob: logprobs[i] ?? -0.05,
      },
    ]),
  });
}

const AUDIO: NetFixtureStep = {
  expect: 'ws-send',
  match: 'json',
  where: { message_type: 'input_audio_chunk' },
  repeat: 'until-next',
};

const OPEN: NetFixtureStep = {
  expect: 'ws-open',
  url: /^wss:\/\/api\.elevenlabs\.io\/v1\/speech-to-text\/realtime\?/,
  headers: { 'xi-api-key': 'fixture-key' },
};

/** One caller utterance: audio and a partial, then the host's commit and its transcript. */
function utterance(say: string): NetFixtureStep[] {
  return [
    AUDIO,
    { send: partial(say.split(' ').slice(0, 2).join(' ')) },
    {
      expect: 'ws-send',
      match: 'json',
      where: { message_type: 'input_audio_chunk', commit: true },
    },
    { send: committed(say) },
    { send: committedWords(say) },
  ];
}

/**
 * The documented manual-commit sequence: session_started, audio chunks with partials, then a
 * chunk with `commit: true` answered by the committed transcript and its word-level message (the
 * default binding asks for `include_timestamps`). Every audio frame is a JSON
 * input_audio_chunk, so the trailing repeated step also absorbs a later commit nothing answers.
 */
export const scribeTemplate: FixtureTemplate = ({ turns }) => [
  {
    host: 'api.elevenlabs.io',
    source: SOURCE,
    retrieved: RETRIEVED,
    steps: [
      OPEN,
      { send: sessionStarted() },
      ...turns.flatMap((turn) => (turn.say ? utterance(turn.say) : [])),
      AUDIO,
    ],
  },
];

export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: scribeTemplate };

/** One English utterance, the shape the distribution's fixture profile replays. */
const HELLO: FixtureTemplateInput = {
  format: MULAW_8K,
  language: 'en',
  sessionId: 'fixture',
  turns: [{ atMs: 0, say: 'hello there' }],
};
export const fixtures: Record<string, NetFixtureScript[]> = { [ID]: scribeTemplate(HELLO) };
