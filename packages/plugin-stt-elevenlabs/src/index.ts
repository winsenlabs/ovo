import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { SCRIBE_CAPABILITIES } from './capabilities.ts';
import {
  ElevenLabsStt,
  SCRIBE_HOSTS,
  SCRIBE_MODELS,
  SCRIBE_REGIONS,
  type ElevenLabsSttBinding,
} from './provider.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  SCRIBE_CAPABILITIES,
  scribeCapabilitiesFor,
  scribeSupportsLanguage,
} from './capabilities.ts';
export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  ElevenLabsStt,
  scribeUrl,
  type ElevenLabsSttBinding,
} from './provider.ts';
export { ElevenLabsSttError } from './protocol.ts';
export { fixtures, fixtureTemplates };

export const elevenLabsSttPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-stt-elevenlabs',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'stt',
    provider: 'elevenlabs',
    provides: [`${Cap.stt}@2`],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        binding: { type: 'object' },
        credentialRef: { type: 'object' },
        workspaceId: { type: 'string' },
        bindingId: { type: 'string' },
        updatedAt: { type: 'string' },
      },
      additionalProperties: false,
    },
    bindingSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: [...SCRIBE_MODELS], default: 'scribe_v2_realtime' },
        // 'in' and 'sg' are data-residency endpoints that need an account provisioned there.
        region: { type: 'string', enum: [...SCRIBE_REGIONS], default: 'default' },
        fallbackRegion: { type: 'string', enum: [...SCRIBE_REGIONS] },
        // Two attempts at the default fit the worker's fifteen-second pre-session buffer. A longer
        // deadline survives a slower handshake but drops the oldest buffered caller audio.
        connectTimeoutMs: { type: 'integer', minimum: 500, maximum: 15_000, default: 6_000 },
        commitStrategy: { type: 'string', enum: ['manual', 'vad'], default: 'manual' },
        // Read only with commitStrategy 'vad'.
        vadSilenceThresholdSecs: { type: 'number', exclusiveMinimum: 0, maximum: 10 },
        vadThreshold: { type: 'number', minimum: 0, maximum: 1 },
        minSpeechDurationMs: { type: 'integer', minimum: 0, maximum: 10_000 },
        minSilenceDurationMs: { type: 'integer', minimum: 0, maximum: 10_000 },
        languageMode: { type: 'string', enum: ['auto', 'session'], default: 'auto' },
        // The provider accepts up to 50 keyterms of up to 20 characters each.
        keyterms: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: 20 },
        },
        noVerbatim: { type: 'boolean', default: false },
        enableLogging: { type: 'boolean', default: true },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: SCRIBE_CAPABILITIES,
    meters: [
      {
        key: 'elevenlabs.streaming-stt.audio_seconds',
        unit: 'audio_seconds',
        label: 'ElevenLabs Scribe realtime audio seconds',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: [...SCRIBE_HOSTS], modelLicences: [] },
    conformance: ['stt@1'],
    ui: { label: 'ElevenLabs Scribe v2 Realtime STT', vendor: 'ElevenLabs', slot: 'stt' },
  },
  async (ctx, row) => {
    const key = await ctx.secret('');
    ctx.provide(
      Cap.stt,
      new ElevenLabsStt(ctx.net, key, (row.binding ?? {}) as ElevenLabsSttBinding),
    );
  },
);

export const plugins = [elevenLabsSttPlugin];
