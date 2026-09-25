import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { SARVAM_STT_CAPABILITIES, SarvamStt, type SarvamSttBinding } from './stt.ts';
import { SARVAM_TTS_CAPABILITIES, SarvamTts, type SarvamTtsBinding } from './tts.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export { SarvamStt, sarvamSttUrl, SARVAM_STT_CAPABILITIES } from './stt.ts';
export { SarvamTts, sarvamTtsUrl, SARVAM_TTS_CAPABILITIES } from './tts.ts';
export { SarvamSttError } from './stt-session.ts';
export { SarvamTtsError } from './tts-session.ts';
export { fixtures, fixtureTemplates };

const configSchema = {
  type: 'object',
  properties: {
    binding: { type: 'object' },
    credentialRef: { type: 'object' },
    workspaceId: { type: 'string' },
    bindingId: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const sarvamSttPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-stt-sarvam',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'stt',
    provider: 'sarvam',
    provides: [`${Cap.stt}@2`],
    requires: [],
    configSchema,
    bindingSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', default: 'saaras:v3-realtime' },
        mode: {
          type: 'string',
          enum: ['transcribe', 'translate', 'verbatim', 'translit', 'codemix'],
        },
        languageCode: { type: 'string' },
        streamType: { type: 'string', enum: ['fast', 'balanced'] },
        silenceDurationMs: { type: 'integer', minimum: 1, default: 500 },
        endpointing: { type: 'string', enum: ['vad', 'manual'], default: 'vad' },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: SARVAM_STT_CAPABILITIES,
    meters: [
      {
        key: 'sarvam.streaming-stt.audio_seconds',
        unit: 'audio_seconds',
        label: 'Sarvam realtime STT audio seconds',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: ['api.sarvam.ai'], modelLicences: [] },
    conformance: ['stt@1'],
    ui: { label: 'Sarvam Saaras Realtime STT', vendor: 'Sarvam', slot: 'stt' },
  },
  async (ctx, row) => {
    const key = await ctx.secret('');
    ctx.provide(Cap.stt, new SarvamStt(ctx.net, key, (row.binding ?? {}) as SarvamSttBinding));
  },
);

export const sarvamTtsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-tts-sarvam',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'sarvam',
    provides: [`${Cap.tts}@2`],
    requires: [],
    configSchema,
    bindingSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', enum: ['bulbul:v2', 'bulbul:v3'], default: 'bulbul:v3' },
        speaker: { type: 'string', default: 'shubh' },
        pace: { type: 'number', minimum: 0.5, maximum: 2 },
        temperature: { type: 'number', minimum: 0.01, maximum: 1 },
        dictId: { type: 'string' },
        restFallback: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: SARVAM_TTS_CAPABILITIES,
    meters: [
      {
        key: 'sarvam.streaming-tts.characters',
        unit: 'characters',
        label: 'Sarvam streaming TTS characters',
        role: 'tts',
      },
    ],
    runtime: { egressHosts: ['api.sarvam.ai'], modelLicences: [] },
    conformance: ['tts@1'],
    ui: { label: 'Sarvam Bulbul TTS', vendor: 'Sarvam', slot: 'tts' },
  },
  async (ctx, row) => {
    const key = await ctx.secret('');
    ctx.provide(Cap.tts, new SarvamTts(ctx.net, key, (row.binding ?? {}) as SarvamTtsBinding));
  },
);

export const plugins = [sarvamSttPlugin, sarvamTtsPlugin];
