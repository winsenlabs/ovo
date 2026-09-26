import { describe, expect, it } from 'vitest';
import { MULAW_8K, type SessionInput, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { createFakeCarrier } from '../../conformance/src/drivers/fake-carrier.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';
import { NativeStreamingSpeechOutput } from '../src/speech/media-output-v2.ts';

const session: SessionInput = {
  mode: 'faq',
  language: 'en-US',
  inputEnabled: false,
  variables: {},
  maxCallSeconds: 60,
  acknowledgements: [],
};

describe('incremental synthesis cleanup', () => {
  it.each(['push', 'flush'] as const)(
    'closes the acquired session once when %s throws',
    async (failureAt) => {
      const failure = new Error(`${failureAt} failed`);
      let closed = 0;
      const tts: TextToSpeech = {
        capabilities: {
          outputFormats: [MULAW_8K],
          languages: ['en-US'],
          interim: false,
          wordTimestamps: false,
          turnSignals: [],
          forceEndpoint: false,
          incrementalText: true,
        },
        cacheIdentity: () => ({ provider: 'fixture', model: 'test', voice: 'v', revision: '1' }),
        async *synthesize() {
          throw new Error('batch synthesis must not be used');
        },
        async open() {
          // This provider ignores AbortSignal: only close releases the acquired session.
          return {
            push() {
              if (failureAt === 'push') throw failure;
            },
            flush() {
              if (failureAt === 'flush') throw failure;
            },
            audio: {
              async *[Symbol.asyncIterator]() {
                throw new Error('audio must not be read');
              },
            },
            async close() {
              closed++;
            },
          };
        },
      };
      const carrier = createFakeCarrier();
      const output = new NativeStreamingSpeechOutput(tts, carrier.duplex, session, () => undefined);
      const speech = new BoundedSpeechScheduler(output);
      try {
        await expect(speech.speak('test')).rejects.toBe(failure);
        expect(closed).toBe(1);
        expect(
          carrier.log.filter((event) => event.type === 'audio' || event.type === 'mark'),
        ).toEqual([]);
      } finally {
        output.dispose();
        await speech.dispose();
      }
      expect(closed).toBe(1);
    },
  );
});
