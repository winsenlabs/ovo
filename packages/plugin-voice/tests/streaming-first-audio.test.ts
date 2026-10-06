import { expect, it } from 'vitest';
import type { SessionInput, SpeechSegment, TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { createScriptedTts } from '../../conformance/src/drivers/scripted-speech.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';

const session: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: false,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

// LAT-1: synthesis and carrier writes overlap. If output waited for a finished sentence, the
// carrier would see nothing until the provider closed the stream.
it('sends first carrier audio before synthesis of the segment completes', async () => {
  const carrier = createFakeCarrier();
  const order: string[] = [];
  let finishSynthesis!: () => void;
  const synthesisGate = new Promise<void>((resolve) => (finishSynthesis = resolve));
  const tts: TextToSpeech = {
    ...createScriptedTts(),
    async *synthesize() {
      order.push('tts:first-chunk');
      yield new Uint8Array(160).fill(0xff);
      await synthesisGate;
      order.push('tts:last-chunk');
      yield new Uint8Array(160).fill(0xff);
    },
  };
  const media = {
    ...carrier.duplex,
    async sendAudio(bytes: Uint8Array, signal?: AbortSignal) {
      order.push('carrier:audio');
      await carrier.duplex.sendAudio(bytes, signal);
    },
  };
  const output = new NativeStreamingSpeechOutput(tts, media, session, () => undefined, {
    markTimeoutMs: 500,
  });
  const timing: string[] = [];
  output.configureTiming((phase) => timing.push(phase));
  const segment: SpeechSegment = {
    id: 'speech-1',
    text: 'Your balance is ready.',
    epoch: 1,
    kind: 'response',
    generatedAt: 0,
  };

  const played = output.play(segment, { signal: new AbortController().signal });
  await until(() => order.includes('carrier:audio'));

  expect(order).toEqual(['tts:first-chunk', 'carrier:audio']);
  expect(timing).toEqual(['tts-first-byte', 'carrier-first-audio']);
  finishSynthesis();
  await expect(played).resolves.toMatchObject({ state: 'completed' });
  expect(order).toEqual(['tts:first-chunk', 'carrier:audio', 'tts:last-chunk', 'carrier:audio']);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
