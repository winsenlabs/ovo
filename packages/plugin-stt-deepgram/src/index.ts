import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { DEEPGRAM_CAPABILITIES, DeepgramStt, type DeepgramConfig } from './deepgram.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export { DeepgramStt, listenUrl, DEEPGRAM_CAPABILITIES, type DeepgramConfig } from './deepgram.ts';
export { fixtures, fixtureTemplates };

export const deepgramPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-provider-deepgram-stt',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'stt',
    provider: 'deepgram',
    provides: [`${Cap.stt}@2`],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        binding: { type: 'object' },
        credentialRef: { type: 'object' },
      },
      additionalProperties: false,
    },
    bindingSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', default: 'nova-3' },
        language: { type: 'string' },
        endpointingMs: { type: 'integer', minimum: 1 },
        utteranceEndMs: { type: 'integer', minimum: 1, default: 1000 },
        keyterms: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    secretFields: ['/credentialRef'],
    capabilities: DEEPGRAM_CAPABILITIES,
    meters: [{
      key: 'deepgram.streaming-stt.audio_seconds', unit: 'audio_seconds',
      label: 'Deepgram streaming audio seconds', role: 'stt',
    }],
    runtime: { egressHosts: ['api.deepgram.com'], modelLicences: [] },
    conformance: ['stt@1'],
    ui: { label: 'Deepgram Streaming STT', vendor: 'Deepgram', slot: 'stt' },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as DeepgramConfig;
    const apiKey = await ctx.secret('/credentialRef');
    ctx.provide(Cap.stt, new DeepgramStt(ctx.net, apiKey, binding));
  },
);

export const plugins = [deepgramPlugin];
