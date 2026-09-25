import {
  MULAW_8K,
  bytesPerSecond,
  type AudioFormat,
  type FixtureTemplate,
  type NetFixtureScript,
  type NetFixtureStep,
} from '@winsendotai/ovo-contracts';

const STT_ID = '@winsendotai/ovo-stt-sarvam';
const TTS_ID = '@winsendotai/ovo-tts-sarvam';
const RETRIEVED = '2026-09-26';
const STT_SOURCE =
  'https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming';
// WebSocket config uses language_code. The older target_language_code wording is UNCONFIRMED.
const TTS_SOURCE =
  'https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/streaming-api/web-socket';

export const sarvamSttTemplate: FixtureTemplate = (input): NetFixtureScript[] => {
  if (input.turns.filter((turn) => Boolean(turn.say)).length > 1)
    throw new Error('Sarvam STT multi-turn fixture requires an audio-gated replay step');
  const steps: NetFixtureStep[] = [
    {
      expect: 'ws-open',
      url: /^wss:\/\/api\.sarvam\.ai\/speech-to-text-realtime\/ws\?/,
      headers: { 'api-subscription-key': 'fixture-key' },
    },
    { send: JSON.stringify({ event: 'session.begin' }) },
    { expect: 'ws-send', match: 'json', where: { event: 'audio_input' }, repeat: 'until-next' },
  ];
  for (const turn of input.turns) {
    if (!turn.say) continue;
    steps.push({ send: JSON.stringify({ event: 'vad.speech_start' }) });
    steps.push({
      send: JSON.stringify({
        event: 'transcript.partial',
        text: turn.say.split(' ').slice(0, 2).join(' '),
      }),
    });
    steps.push({ send: JSON.stringify({ event: 'vad.speech_end' }) });
    steps.push({ send: JSON.stringify({ event: 'transcript.final', text: turn.say }) });
  }
  steps.push(
    { expect: 'ws-send', match: 'json', where: { event: 'end' } },
    { send: JSON.stringify({ event: 'session.end', audio_duration_s: 1.2 }) },
    { close: { code: 1000 } },
  );
  return [{ host: 'api.sarvam.ai', source: STT_SOURCE, retrieved: RETRIEVED, steps }];
};

export const sarvamTtsTemplate: FixtureTemplate = (input): NetFixtureScript[] =>
  (input.agentTexts ?? []).map((text) => {
    const steps: NetFixtureStep[] = [
      {
        expect: 'ws-open',
        url: /^wss:\/\/api\.sarvam\.ai\/text-to-speech\/ws\?/,
        headers: { 'api-subscription-key': 'fixture-key' },
      },
      {
        expect: 'ws-send',
        match: 'json',
        where: {
          type: 'config',
          data: {
            speaker: 'shubh',
            language_code: input.language,
            output_audio_codec: input.format.encoding === 'mulaw' ? 'mulaw' : 'linear16',
            speech_sample_rate: input.format.sampleRate,
          },
        },
      },
      { expect: 'ws-send', match: 'json', where: { type: 'text', data: { text } } },
      { expect: 'ws-send', match: 'json', where: { type: 'flush' } },
      {
        send: JSON.stringify({
          type: 'audio',
          data: {
            audio: base64(audio(input.format, 120, 1)),
            content_type: 'audio/raw',
            request_id: 'sarvam-tts-fixture',
          },
        }),
      },
      {
        send: JSON.stringify({
          type: 'audio',
          data: {
            audio: base64(audio(input.format, 120, 2)),
            content_type: 'audio/raw',
            request_id: 'sarvam-tts-fixture',
          },
        }),
      },
      { send: JSON.stringify({ type: 'event', data: { event_type: 'final' } }) },
    ];
    return { host: 'api.sarvam.ai', source: TTS_SOURCE, retrieved: RETRIEVED, steps };
  });

function audio(format: AudioFormat, ms: number, seed: number): Uint8Array {
  const out = new Uint8Array(Math.floor((bytesPerSecond(format) * ms) / 1000));
  for (let index = 0; index < out.length; index += 1)
    out[index] =
      format.encoding === 'mulaw'
        ? (0x80 + index * seed) & 255
        : (index * seed + format.sampleRate / 1000) & 255;
  return out;
}

function base64(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}

export const fixtures: Record<string, NetFixtureScript[]> = {
  [STT_ID]: sarvamSttTemplate({
    format: MULAW_8K,
    language: 'hi-IN',
    sessionId: 'fixture',
    turns: [{ atMs: 0, say: 'नमस्ते' }],
  }),
  [TTS_ID]: sarvamTtsTemplate({
    format: MULAW_8K,
    language: 'hi-IN',
    sessionId: 'fixture',
    turns: [],
    agentTexts: ['नमस्ते'],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = {
  [STT_ID]: sarvamSttTemplate,
  [TTS_ID]: sarvamTtsTemplate,
};
