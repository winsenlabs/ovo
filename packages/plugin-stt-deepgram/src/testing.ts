import { type FixtureTemplate, type NetFixtureScript } from '@winsendotai/ovo-contracts';

const SOURCE = 'https://developers.deepgram.com/reference/speech-to-text/listen-streaming';
const ID = '@winsendotai/ovo-provider-deepgram-stt';

export const deepgramTemplate: FixtureTemplate = (input): NetFixtureScript[] => {
  const says = input.turns.flatMap((turn) => turn.say ? [turn.say] : []);
  return [{
    host: 'api.deepgram.com', source: SOURCE, retrieved: '2026-09-25',
    steps: [
      { expect: 'ws-open', url: /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/, headers: { authorization: 'Token fixture-key' } },
      { expect: 'ws-send', match: 'binary', repeat: 'until-next' },
      ...says.flatMap((text, index) => [
        { send: JSON.stringify({ type: 'SpeechStarted', timestamp: index + 0.1 }) },
        { send: result(text, false, false) },
        { send: result(text, true, false) },
        { send: result('', true, true) },
        { send: JSON.stringify({ type: 'UtteranceEnd', last_word_end: index + 0.8 }) },
      ]),
      { expect: 'ws-send', match: 'json', where: { type: 'CloseStream' } },
      { send: JSON.stringify({ type: 'Metadata', request_id: 'dg-fixture-request', duration: 1.2 }) },
      { close: { code: 1000 } },
    ],
  }];
};

function result(text: string, isFinal: boolean, speechFinal: boolean): string {
  return JSON.stringify({
    type: 'Results', start: 0, duration: 0.8, is_final: isFinal,
    speech_final: speechFinal, from_finalize: false,
    channel: { alternatives: [{ transcript: text, confidence: 0.98, words: [] }] },
  });
}

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: deepgramTemplate({
    format: { encoding: 'mulaw', sampleRate: 8000, channels: 1 },
    language: 'en', sessionId: 'fixture', turns: [{ atMs: 0, say: 'hello' }],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: deepgramTemplate };
