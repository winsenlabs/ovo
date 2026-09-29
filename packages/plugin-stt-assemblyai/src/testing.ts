import {
  MULAW_8K,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';

const ID = '@winsendotai/ovo-stt-assemblyai';
const SOURCE = 'https://www.assemblyai.com/docs/streaming/message-sequence';
const RETRIEVED = '2026-09-26';

/** The conformance template follows the documented Begin, Turn and Termination sequence. */
export const assemblyAiTemplate: FixtureTemplate = (input): NetFixtureScript[] => {
  const says = input.turns.flatMap((turn) => (turn.say ? [turn.say] : []));
  const steps: NetFixtureStep[] = [
    {
      expect: 'ws-open',
      url: /^wss:\/\/streaming\.assemblyai\.com\/v3\/ws\?/,
      headers: { authorization: 'fixture-key' },
    },
    {
      send: JSON.stringify({
        type: 'Begin',
        id: 'assemblyai-fixture-request',
        expires_at: '2026-09-26T00:00:00Z',
        configuration: { model: 'universal-streaming-english' },
      }),
    },
    { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
    ...says.flatMap((say, index): NetFixtureStep[] => [
      { send: JSON.stringify({ type: 'SpeechStarted', timestamp: index * 1000 }) },
      {
        send: JSON.stringify({
          type: 'Turn',
          turn_order: index,
          transcript: say.split(' ').slice(0, 2).join(' '),
          end_of_turn: false,
          turn_is_formatted: false,
        }),
      },
      {
        send: JSON.stringify({
          type: 'Turn',
          turn_order: index,
          transcript: say,
          end_of_turn: true,
          turn_is_formatted: false,
          end_of_turn_confidence: 0.95,
        }),
      },
    ]),
    { expect: 'ws-send', match: 'json', where: { type: 'Terminate' } },
    { send: JSON.stringify({ type: 'Termination', session_duration_seconds: 1.2 }) },
    { close: { code: 1000 } },
  ];
  return [{ host: 'streaming.assemblyai.com', source: SOURCE, retrieved: RETRIEVED, steps }];
};

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: assemblyAiTemplate({
    format: MULAW_8K,
    language: 'en',
    sessionId: 'fixture',
    turns: [{ atMs: 0, say: 'hello there' }],
  }),
};

export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: assemblyAiTemplate };
