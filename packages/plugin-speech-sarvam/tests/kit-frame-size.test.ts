import { checkSpeechToText } from '@winsendotai/ovo-conformance';
import { expect, it } from 'vitest';
import { SarvamStt } from '../src/stt.ts';
import { sarvamSttTemplate } from '../src/testing.ts';

it('the shared STT kit measures Sarvam JSON-framed audio against frameMs', async () => {
  const failures = await checkSpeechToText(
    ({ net, clock }) => {
      const stt = new SarvamStt(net, 'fixture-key', {}, clock);
      return Object.assign(stt, {
        capabilities: { ...stt.capabilities, frameMs: { min: 20, preferred: 20, max: 50 } },
      });
    },
    { template: sarvamSttTemplate, language: 'hi-IN' },
    { only: ['a scripted utterance'] },
  );
  expect(failures.map((failure) => failure.message).join('\n')).toMatch(
    /frame \d+ is 100\.0 ms, above frameMs\.max/,
  );
});
