import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  ASSEMBLYAI_CAPABILITIES,
  ASSEMBLYAI_MODELS,
  AssemblyAiStt,
  type AssemblyAiBinding,
} from './provider.ts';
import { ENDPOINTING_PRESETS } from './endpointing.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  AssemblyAiStt,
  assemblyAiCapabilitiesFor,
  assemblyAiUrl,
  ASSEMBLYAI_CAPABILITIES,
  ASSEMBLYAI_MODELS,
  DEFAULT_CONNECT_TIMEOUT_MS,
} from './provider.ts';
export {
  assemblyAiLanguageCodes,
  assemblyAiLanguages,
  assemblyAiSupportsLanguage,
} from './languages.ts';
export {
  assemblyAiTurnDetection,
  ENDPOINTING_PRESETS,
  updateConfigurationMessage,
  type AssemblyAiConfigurationUpdate,
  type EndpointingPreset,
} from './endpointing.ts';
export { AssemblyAiProviderError, AssemblyAiSession } from './session.ts';
export { fixtures, fixtureTemplates };

export const assemblyAiPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-stt-assemblyai',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'stt',
    provider: 'assemblyai',
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
        model: {
          type: 'string',
          enum: [...ASSEMBLYAI_MODELS],
          default: 'universal-streaming-english',
        },
        // The US endpoint answered Begin faster from India (0.72s against 1.16s); EU data
        // residency selects 'eu' explicitly.
        region: { type: 'string', enum: ['default', 'us', 'eu'], default: 'us' },
        fallbackRegion: { type: 'string', enum: ['default', 'us', 'eu'] },
        // The handshake took 2-5s from asia-south1. Two attempts at the default fit the worker's
        // fifteen-second pre-session buffer; a longer deadline survives a slower handshake but
        // drops the oldest buffered caller audio.
        connectTimeoutMs: { type: 'integer', minimum: 500, maximum: 15_000, default: 6_000 },
        // Provider presets; the explicit turn fields below override them.
        endpointing: { type: 'string', enum: [...ENDPOINTING_PRESETS] },
        minTurnSilenceMs: { type: 'integer', minimum: 50, maximum: 10_000 },
        maxTurnSilenceMs: { type: 'integer', minimum: 1 },
        endOfTurnConfidenceThreshold: { type: 'number', minimum: 0, maximum: 1 },
        vadThreshold: { type: 'number', minimum: 0, maximum: 1 },
        keyterms: { type: 'array', maxItems: 100, items: { type: 'string' } },
        // Sent to the pro models only.
        prompt: { type: 'string', minLength: 1, maxLength: 1_750 },
        inactivityTimeoutSec: { type: 'integer', minimum: 5, maximum: 3_600 },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: ASSEMBLYAI_CAPABILITIES,
    meters: [
      {
        key: 'assemblyai.streaming-stt.session_seconds',
        unit: 'session_seconds',
        label: 'AssemblyAI streaming session seconds',
        role: 'stt',
      },
    ],
    runtime: {
      egressHosts: [
        'streaming.assemblyai.com',
        'streaming.us.assemblyai.com',
        'streaming.eu.assemblyai.com',
      ],
      modelLicences: [],
    },
    conformance: ['stt@1'],
    ui: { label: 'AssemblyAI Universal Streaming STT', vendor: 'AssemblyAI', slot: 'stt' },
  },
  async (ctx, row) => {
    const key = await ctx.secret('');
    ctx.provide(Cap.stt, new AssemblyAiStt(ctx.net, key, (row.binding ?? {}) as AssemblyAiBinding));
  },
);

export const plugins = [assemblyAiPlugin];
