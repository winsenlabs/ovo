import { describeTextToSpeech } from '@winsendotai/ovo-conformance';
import type { RumikTtsBinding } from '../src/binding.ts';
import { RumikTts } from '../src/tts.ts';
import { FIXTURE_BINDING, FIXTURE_KEY, rumikTtsTemplate } from '../src/testing.ts';

// R7: the tts@1 kit for both native formats (μ-law 8 kHz, PCM16 24 kHz). The incremental checks
// skip themselves: Silk takes no incremental text, so `incrementalText` is false and there is no
// `open()`. A reply renders the same frames as consecutive syntheses (segments are generations on
// one queue), so the reply scripts are the template's.
const VARIANTS: [string, RumikTtsBinding][] = [
  ['model', { model: 'muga' }],
  ['speaker', { speaker: 'siya' }],
  ['description', { description: 'a warm 30s male voice, conversational pacing' }],
  ['defaultTone', { defaultTone: 'happy' }],
  ['temperature', { temperature: 0.7 }],
  ['topP', { topP: 0.9 }],
  ['topK', { topK: 40 }],
  ['repetitionPenalty', { repetitionPenalty: 1.1 }],
  ['maxNewTokens', { maxNewTokens: 4096 }],
  ['normalization', { normalization: true }],
];

describeTextToSpeech(
  'Rumik Silk mulberry over a minted socket',
  ({ net, clock }) => new RumikTts(net, FIXTURE_KEY, FIXTURE_BINDING, clock),
  {
    template: rumikTtsTemplate,
    language: 'hi-IN',
    replyScripts: (texts, format) =>
      rumikTtsTemplate({
        format,
        language: 'hi-IN',
        sessionId: 'kit',
        turns: [],
        agentTexts: texts,
      }),
    distinctRequestIds: true,
    identityVariants: VARIANTS.map(([name, binding]) => ({
      name,
      factory: ({ net, clock }) =>
        new RumikTts(net, FIXTURE_KEY, { ...FIXTURE_BINDING, ...binding }, clock),
    })),
  },
);
