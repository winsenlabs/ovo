import { Cap, MULAW_8K, type StreamingStt } from '@winsendotai/ovo-contracts';
import { legacyAsStt } from '@winsendotai/ovo-plugin-kit';
import {
  createDeepgramSttPlugin,
  deepgramBindingFromRecord,
} from '@winsendotai/ovo-plugin-providers';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  factoryContext,
  providerUsage,
  PROVIDER_MANIFEST_COMMON,
  storedBinding,
} from './support.ts';

export const deepgramSttBridge = definePlugin(
  {
    id: '@winsendotai/ovo-provider-deepgram-stt',
    ...PROVIDER_MANIFEST_COMMON,
    kind: 'stt',
    provider: 'deepgram',
    provides: [`${Cap.stt}@2`],
    bindingSchema: {
      type: 'object',
      required: ['model'],
      properties: {
        model: { type: 'string', minLength: 1 },
        language: { type: 'string' },
        endpointingMs: { type: 'integer' },
        utteranceEndMs: { type: 'integer' },
        connectAttempts: { type: 'integer' },
        connectTimeoutMs: { type: 'integer' },
        finishTimeoutMs: { type: 'integer' },
        maxSessionMs: { type: 'integer' },
        keepAliveMs: { type: 'integer' },
        maxInputChunkBytes: { type: 'integer' },
        maxBufferedBytes: { type: 'integer' },
        maxMessageBytes: { type: 'integer' },
      },
      additionalProperties: false,
    },
    capabilities: {
      inputFormats: [MULAW_8K],
      languages: ['*'],
      interim: true,
      wordTimestamps: false,
      turnSignals: ['speech-start', 'end-of-turn'],
      forceEndpoint: false,
    },
    meters: [
      {
        key: 'deepgram.streaming-stt.audio_seconds',
        unit: 'audio_seconds',
        label: 'Deepgram streaming audio',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: ['api.deepgram.com'], modelLicences: [] },
    conformance: ['stt@1'],
  },
  async (ctx, config) => {
    const binding = deepgramBindingFromRecord(storedBinding(config, 'deepgram'));
    const old = createDeepgramSttPlugin(binding, { usage: providerUsage(ctx, 'stt') });
    await old.apply(
      factoryContext(ctx, (key, value) => {
        if (key !== Cap.stt) throw new Error(`Unexpected Deepgram service ${key}`);
        ctx.provide(Cap.stt, legacyAsStt(value as StreamingStt));
      }),
      {},
    );
  },
);
