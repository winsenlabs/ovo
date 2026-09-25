import { describe, expect, it } from 'vitest';
import { MULAW_8K, PCM16_24K, type UsageMeter } from '@winsendotai/ovo-contracts';
import { mulawToPcm16 } from '@winsendotai/ovo-audio';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { adaptTextToSpeech } from '../../session-host/src/speech-adapters/tts-format.ts';
import { OpenAiTts } from '../src/tts.ts';

const source = 'https://platform.openai.com/docs/api-reference/audio/createSpeech';
const speechUrl = 'https://api.openai.com/v1/audio/speech';
function pcmTone(freq: number, seconds = 0.8): Uint8Array {
  const out = new Uint8Array(Math.round(24000 * seconds) * 2);
  for (let i = 0; i < out.byteLength / 2; i += 1) {
    const value = Math.round(12000 * Math.sin(2 * Math.PI * freq * i / 24000));
    out[i * 2] = value & 255;
    out[i * 2 + 1] = (value >> 8) & 255;
  }
  return out;
}
function base64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function netFor(model: string, chunks: Uint8Array[]) {
  return createFixtureNet([{ host: 'api.openai.com', source, retrieved: '2026-09-25',
    steps: [{ expect: 'http', method: 'POST', url: speechUrl,
      headers: { authorization: 'Bearer fixture-key' }, body: 'json',
      where: { model, response_format: 'pcm' },
      reply: { status: 200, headers: { 'x-request-id': 'tts-real-id' },
        chunks: chunks.map((bytes) => ({ base64: base64(bytes) })) } }] }]);
}
async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}
function amplitude(signal: Int16Array, rate: number, freq: number): number {
  const steady = signal.subarray(Math.round(rate * 0.1), Math.round(rate * 0.6));
  let re = 0;
  let im = 0;
  for (let i = 0; i < steady.length; i += 1) {
    const phase = 2 * Math.PI * freq * i / rate;
    re += steady[i]! * Math.cos(phase);
    im -= steady[i]! * Math.sin(phase);
  }
  return 2 * Math.hypot(re, im) / steady.length;
}

describe('OpenAI TTS documented wire protocol', () => {
  it('joins odd-byte raw PCM chunks without dropping a sample', async () => {
    const bytes = pcmTone(300, 0.1);
    const net = netFor('tts-1', [bytes.slice(0, 101), bytes.slice(101, 777), bytes.slice(777)]);
    const usage: UsageMeter[] = [];
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' });
    const output = await collect(tts.synthesize({ sessionId: 's1', text: 'Hello', format: PCM16_24K,
      language: 'en', signal: new AbortController().signal, onUsage: (meter) => usage.push(meter) }));
    expect(output).toEqual(bytes);
    expect(usage).toMatchObject([{ unit: 'characters', quantity: '5', state: 'estimated', requestId: 'tts-real-id' }]);
    net.assertComplete();
  });

  it('takes mini TTS token usage from speech.audio.done over SSE', async () => {
    const bytes = pcmTone(300, 0.1);
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const body = event({ type: 'speech.audio.delta', audio: base64(bytes) }) +
      event({ type: 'speech.audio.done', usage: { input_tokens: 7, output_tokens: 19, total_tokens: 26 } });
    const net = createFixtureNet([{ host: 'api.openai.com', source, retrieved: '2026-09-25',
      steps: [{ expect: 'http', method: 'POST', url: speechUrl,
        where: { model: 'gpt-4o-mini-tts', stream_format: 'sse' },
        reply: { status: 200, headers: { 'x-request-id': 'tts-sse-id' }, body } }] }]);
    const usage: UsageMeter[] = [];
    const tts = new OpenAiTts(net, 'fixture-key', { model: 'gpt-4o-mini-tts', voice: 'alloy' });
    expect(await collect(tts.synthesize({ sessionId: 's1', text: 'Hello', format: PCM16_24K,
      language: 'en', signal: new AbortController().signal, onUsage: (meter) => usage.push(meter) }))).toEqual(bytes);
    expect(usage).toMatchObject([
      { unit: 'input_tokens', quantity: '7', state: 'reconciled', requestId: 'tts-sse-id' },
      { unit: 'audio_output_tokens', quantity: '19', state: 'reconciled', requestId: 'tts-sse-id' },
    ]);
    net.assertComplete();
  });

  it('attenuates a 6 kHz alias by at least 60 dB through the real host TTS adapter', async () => {
    const render = async (freq: number) => {
      const net = netFor('tts-1', [pcmTone(freq).slice(0, 101), pcmTone(freq).slice(101)]);
      const tts = adaptTextToSpeech(new OpenAiTts(net, 'fixture-key', { model: 'tts-1', voice: 'alloy' }));
      const output = await collect(tts.synthesize({ sessionId: 's1', text: 'Tone', format: MULAW_8K,
        language: 'en', signal: new AbortController().signal, onUsage: () => undefined }));
      net.assertComplete();
      return mulawToPcm16(output);
    };
    const reference = amplitude(await render(1000), 8000, 1000);
    const folded = amplitude(await render(6000), 8000, 2000);
    expect(20 * Math.log10(folded / reference)).toBeLessThanOrEqual(-60);
  });
});
