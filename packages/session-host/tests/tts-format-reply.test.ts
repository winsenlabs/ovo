import { describe, expect, it } from 'vitest';
import { MULAW_8K, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { adaptTextToSpeech } from '../src/speech-adapters/tts-format.ts';

// Wave 2 request #2 / LAT-5: the host's format adapter forwards warm() and openReply(), so the
// speech output sees them on the adapted TTS and the provider sees only its native format.
describe('adaptTextToSpeech forwards reply contexts and warm-up', () => {
  it('passes both through in the native format, and adds neither when absent', async () => {
    const calls: string[] = [];
    const base: TextToSpeech = {
      capabilities: {
        outputFormats: [MULAW_8K],
        languages: ['*'],
        interim: false,
        wordTimestamps: false,
        turnSignals: [],
        forceEndpoint: false,
      },
      cacheIdentity: () => ({ provider: 'p', model: 'm', voice: 'v', revision: '1' }),
      // swallow-ok: never called here.
      async *synthesize() {},
    };
    const adapted = adaptTextToSpeech({
      ...base,
      async warm(input) {
        calls.push(`warm:${input.format.encoding}`);
      },
      async openReply(input) {
        calls.push(`reply:${input.format.encoding}`);
        return {
          // swallow-ok: no audio is read here.
          segment: async function* () {},
          close: async () => undefined,
        };
      },
    });
    await adapted.warm!({ format: MULAW_8K });
    await adapted.openReply!({
      sessionId: 's',
      format: MULAW_8K,
      language: 'en-IN',
      signal: new AbortController().signal,
      onUsage: () => undefined,
    });
    expect(calls).toEqual(['warm:mulaw', 'reply:mulaw']);
    const plain = adaptTextToSpeech(base);
    expect(plain.warm).toBeUndefined();
    expect(plain.openReply).toBeUndefined();
  });
});
