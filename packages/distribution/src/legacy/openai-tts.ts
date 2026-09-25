import { Cap, MULAW_8K, sameFormat, type StreamingTts } from '@winsendotai/ovo-contracts';
import { legacyAsTts } from '@winsendotai/ovo-plugin-kit';
import {
  createOpenAiTtsPlugin,
  openAiTtsBindingFromRecord,
} from '@winsendotai/ovo-plugin-providers';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  factoryContext,
  providerUsage,
  PROVIDER_MANIFEST_COMMON,
  storedBinding,
} from './support.ts';

export const openAiTtsBridge = definePlugin(
  {
    id: '@winsendotai/ovo-provider-openai-tts',
    ...PROVIDER_MANIFEST_COMMON,
    kind: 'tts',
    provider: 'openai',
    provides: [`${Cap.tts}@2`],
    bindingSchema: {
      type: 'object',
      required: ['model', 'voice'],
      properties: {
        model: { type: 'string', minLength: 1 },
        voice: { type: 'string', minLength: 1 },
        instructions: { type: 'string' },
        speed: { type: 'number' },
        requestTimeoutMs: { type: 'integer' },
        maxInputCharacters: { type: 'integer' },
        maxResponseBytes: { type: 'integer' },
        maxOutputChunkBytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    capabilities: {
      outputFormats: [MULAW_8K],
      languages: ['*'],
      interim: false,
      wordTimestamps: false,
      turnSignals: [],
      forceEndpoint: false,
    },
    meters: [
      {
        key: 'openai.streaming-tts.characters',
        unit: 'characters',
        label: 'OpenAI speech characters',
        role: 'tts',
      },
    ],
    runtime: { egressHosts: ['api.openai.com'], modelLicences: [] },
    conformance: ['tts@1'],
  },
  async (ctx, config) => {
    const binding = openAiTtsBindingFromRecord(storedBinding(config, 'openai'));
    const old = createOpenAiTtsPlugin(binding, { usage: providerUsage(ctx, 'tts') });
    await old.apply(
      factoryContext(ctx, (key, value) => {
        if (key !== Cap.tts) return;
        const tts = legacyAsTts(value as StreamingTts, {
          provider: 'openai',
          model: binding.model,
          voice: binding.voice,
          revision: 'openai-tts-mulaw-8000-v1',
        });
        ctx.provide(Cap.tts, {
          ...tts,
          cacheIdentity(format, voice) {
            const identity = tts.cacheIdentity(format, voice);
            return sameFormat(format, MULAW_8K)
              ? identity
              : {
                  ...identity,
                  revision: `${identity.revision}-${format.encoding}-${format.sampleRate}`,
                };
          },
        });
      }),
      {},
    );
  },
);
