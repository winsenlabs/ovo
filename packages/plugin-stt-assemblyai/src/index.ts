import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  ASSEMBLYAI_CAPABILITIES,
  ASSEMBLYAI_MODELS,
  AssemblyAiStt,
  type AssemblyAiBinding,
} from './provider.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  AssemblyAiStt,
  assemblyAiCapabilitiesFor,
  assemblyAiLanguageCodes,
  assemblyAiLanguages,
  assemblyAiSupportsLanguage,
  assemblyAiUrl,
  ASSEMBLYAI_CAPABILITIES,
  ASSEMBLYAI_MODELS,
  DEFAULT_CONNECT_TIMEOUT_MS,
} from './provider.ts';
export { AssemblyAiProviderError } from './session.ts';
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
        // Two attempts at the maximum still fit the worker's ten-second pre-session buffer.
        connectTimeoutMs: { type: 'integer', minimum: 500, maximum: 4_000, default: 3_000 },
        minTurnSilenceMs: { type: 'integer', minimum: 1 },
        maxTurnSilenceMs: { type: 'integer', minimum: 1 },
        endOfTurnConfidenceThreshold: { type: 'number', minimum: 0, maximum: 1 },
        keyterms: { type: 'array', items: { type: 'string' } },
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
