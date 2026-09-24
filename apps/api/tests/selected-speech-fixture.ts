import { Cap, MULAW_8K, type TextToSpeech } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';

const capabilities = {
  outputFormats: [MULAW_8K],
  languages: ['*'],
  interim: false,
  wordTimestamps: false,
  turnSignals: [],
  forceEndpoint: false,
} as const;

/** Release fixtures select a complete local speech graph without provider credentials. */
export const selectedSpeechFixture = definePlugin(
  {
    id: '@fixture/api-tts',
    version: '1.0.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'fixture',
    provides: [`${Cap.tts}@2`],
    requires: [],
    optional: [],
    configSchema: { type: 'object', additionalProperties: false },
    secretFields: [],
    capabilities,
    meters: [{ key: 'fixture.tts.characters', unit: 'characters', label: 'Text', role: 'tts' }],
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['tts@1'],
  },
  (ctx) => {
    ctx.provide(Cap.tts, {
      capabilities,
      cacheIdentity: () => ({ provider: 'fixture', model: 'fixture', voice: '', revision: '1' }),
      async *synthesize() {
        yield Uint8Array.of(1, 2, 3);
      },
    } satisfies TextToSpeech);
  },
);

export const selectedSpeechVoice = {
  tts: { plugin: selectedSpeechFixture.manifest.id, binding: 'env', config: {} },
};
