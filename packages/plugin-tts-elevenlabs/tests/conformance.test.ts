import { describeTextToSpeech } from '@winsendotai/ovo-conformance';
import type { AudioFormat, NetFixtureScript } from '@winsendotai/ovo-contracts';
import type { ElevenLabsTtsBinding } from '../src/binding.ts';
import { ElevenLabsTts } from '../src/tts.ts';
import {
  RETRIEVED,
  WS_SOURCE,
  elevenLabsReplyTemplate,
  elevenLabsTtsTemplate,
  socketOpen,
} from '../src/testing.ts';

/**
 * The provider refuses the first context after its input, before any audio. A policy close (1008:
 * key or quota) is not replayed; a dropped socket (1011) would be, over HTTP (reply.test.ts).
 */
const refusedSocket = (format: AudioFormat): NetFixtureScript[] => [
  {
    host: 'api.elevenlabs.io',
    source: WS_SOURCE,
    retrieved: RETRIEVED,
    steps: [
      socketOpen(format),
      { expect: 'ws-send', match: 'json', where: { context_id: 'ovo-1' } },
      { expect: 'ws-send', match: 'json', where: { context_id: 'ovo-1' }, repeat: 'until-next' },
      { expect: 'ws-send', match: 'json', where: { context_id: 'ovo-1', close_context: true } },
      { close: { code: 1008, reason: 'quota exceeded' } },
    ],
  },
];

const VARIANTS: [string, ElevenLabsTtsBinding][] = [
  ['model', { model: 'eleven_turbo_v2_5' }],
  ['stability', { stability: 0.3 }],
  ['similarityBoost', { similarityBoost: 0.6 }],
  ['style', { style: 0.2 }],
  ['speed', { speed: 1.1 }],
  ['useSpeakerBoost', { useSpeakerBoost: false }],
  ['languageCode', { languageCode: 'hi' }],
  ['applyTextNormalization', { applyTextNormalization: 'off' }],
  ['seed', { seed: 7 }],
  [
    'pronunciationDictionaries',
    { pronunciationDictionaries: [{ id: 'lenders', versionId: 'v2' }] },
  ],
  ['autoMode', { autoMode: false }],
  ['chunkLengthSchedule', { chunkLengthSchedule: [120, 160] }],
];

describeTextToSpeech(
  'ElevenLabs Flash v2.5 multi-context',
  ({ net, clock }) => new ElevenLabsTts(net, 'fixture-key', {}, clock),
  {
    template: elevenLabsTtsTemplate,
    language: 'en-IN',
    incrementalPushes: 2,
    incrementalFailure: refusedSocket,
    replyScripts: (texts, format) =>
      elevenLabsReplyTemplate({
        format,
        language: 'en-IN',
        sessionId: 'kit',
        turns: [],
        agentTexts: texts,
      }),
    distinctRequestIds: true,
    identityVariants: VARIANTS.map(([name, binding]) => ({
      name,
      factory: ({ net, clock }) => new ElevenLabsTts(net, 'fixture-key', binding, clock),
    })),
  },
);
