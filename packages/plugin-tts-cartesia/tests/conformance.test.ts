import { describeTextToSpeech } from '@winsendotai/ovo-conformance';
import type { CartesiaTtsBinding } from '../src/binding.ts';
import { CartesiaTts } from '../src/tts.ts';
import { cartesiaReplyTemplate, cartesiaTtsTemplate, quotaRefusal } from '../src/testing.ts';

const VOICE = 'f91ab3e6-5071-4e15-b016-cde6f2bcd222';

// Every binding field that changes the rendered audio, one at a time (TTS-13).
const VARIANTS: [string, CartesiaTtsBinding][] = [
  ['model', { model: 'sonic-3.6' }],
  ['voiceId', { voiceId: '47c38ca4-5f35-497b-b1a3-415245fb35e1' }],
  ['language', { language: 'hi' }],
  ['normalization', { normalization: 'en-IN' }],
  ['accent', { accent: 'standard-hindi' }],
  ['speed', { speed: 1.2 }],
  ['volume', { volume: 1.5 }],
  ['emotion', { emotion: 'calm' }],
  ['pronunciationDictId', { pronunciationDictId: 'dict-lenders' }],
];

describeTextToSpeech(
  'Cartesia Sonic 3.6 contexts on one socket',
  ({ net, clock }) => new CartesiaTts(net, 'fixture-key', { voiceId: VOICE }, clock),
  {
    template: cartesiaTtsTemplate,
    language: 'en-IN',
    incrementalPushes: 2,
    incrementalFailure: quotaRefusal,
    replyScripts: (texts, format) =>
      cartesiaReplyTemplate({
        format,
        language: 'en-IN',
        sessionId: 'kit',
        turns: [],
        agentTexts: texts,
      }),
    distinctRequestIds: true,
    identityVariants: VARIANTS.map(([name, binding]) => ({
      name,
      factory: ({ net, clock }) =>
        new CartesiaTts(net, 'fixture-key', { voiceId: VOICE, ...binding }, clock),
    })),
  },
);
