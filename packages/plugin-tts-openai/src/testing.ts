import { type FixtureTemplate, type NetFixtureScript } from '@winsendotai/ovo-contracts';

const ID = '@winsendotai/ovo-provider-openai-tts';
const SOURCE = 'https://platform.openai.com/docs/api-reference/audio/createSpeech';

export const openAiTtsTemplate: FixtureTemplate = (input): NetFixtureScript[] =>
  (input.agentTexts ?? []).map((text) => {
    const audio = tone(Math.max(2400, [...text].length * 120));
    const half = Math.max(2, Math.floor(audio.byteLength / 4) * 2);
    const delta = (bytes: Uint8Array) =>
      `data: ${JSON.stringify({ type: 'speech.audio.delta', audio: base64(bytes) })}\n\n`;
    return {
      host: 'api.openai.com',
      source: SOURCE,
      retrieved: '2026-09-25',
      steps: [
        {
          expect: 'http' as const,
          method: 'POST',
          url: 'https://api.openai.com/v1/audio/speech',
          headers: { authorization: 'Bearer fixture-key' },
          body: 'json' as const,
          where: {
            model: 'gpt-4o-mini-tts',
            stream_format: 'sse',
            response_format: 'pcm',
            input: text,
          },
          reply: {
            status: 200,
            headers: { 'x-request-id': 'tts-fixture-request', 'content-type': 'text/event-stream' },
            body:
              delta(audio.slice(0, half)) +
              delta(audio.slice(half)) +
              `data: ${JSON.stringify({ type: 'speech.audio.done', usage: { input_tokens: 12, output_tokens: 24, total_tokens: 36 } })}\n\n` +
              // Observed on the first live call: the API terminates SSE with this sentinel.
              'data: [DONE]\n\n',
          },
        },
      ],
    };
  });

function tone(samples: number): Uint8Array {
  const out = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(8000 * Math.sin((2 * Math.PI * 300 * i) / 24000));
    out[i * 2] = value & 255;
    out[i * 2 + 1] = (value >> 8) & 255;
  }
  return out;
}
function base64(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export const fixtures: Record<string, NetFixtureScript[]> = {
  [ID]: openAiTtsTemplate({
    format: { encoding: 'pcm_s16le', sampleRate: 24000, channels: 1 },
    language: 'en-US',
    sessionId: 'fixture',
    turns: [],
    agentTexts: ['Hello'],
  }),
};
export const fixtureTemplates: Record<string, FixtureTemplate> = { [ID]: openAiTtsTemplate };
