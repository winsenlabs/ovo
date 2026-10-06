import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  OpenAiRealtimeStt,
  REALTIME_STT_CAPABILITIES,
  REALTIME_STT_DELAYS,
  REALTIME_STT_HOST,
  REALTIME_STT_MODELS,
  type OpenAiRealtimeSttBinding,
} from './provider.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  OpenAiRealtimeStt,
  REALTIME_STT_CAPABILITIES,
  REALTIME_STT_MODELS,
  REALTIME_STT_URL,
  realtimeSttCapabilities,
  sessionUpdate,
  type OpenAiRealtimeSttBinding,
} from './provider.ts';
export { OpenAiRealtimeSttError } from './protocol.ts';
export { fixtures, fixtureTemplates };

export const OPENAI_REALTIME_STT_PLUGIN_ID = '@winsendotai/ovo-stt-openai-realtime';
/** The price-card key the cost runtime derives for this plugin's meter. */
export const OPENAI_REALTIME_STT_METER_KEY = 'openai.streaming-stt.audio_seconds';

export const openAiRealtimeSttPlugin = definePlugin(
  {
    id: OPENAI_REALTIME_STT_PLUGIN_ID,
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'stt',
    provider: 'openai',
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
        model: { type: 'string', enum: [...REALTIME_STT_MODELS], default: 'gpt-live-transcribe' },
        // The VAD modes need a model other than gpt-live-transcribe.
        turnDetection: {
          type: 'string',
          enum: ['manual', 'server_vad', 'semantic_vad'],
          default: 'manual',
        },
        silenceDurationMs: { type: 'integer', minimum: 100, maximum: 5_000 },
        vadThreshold: { type: 'number', minimum: 0, maximum: 1 },
        prefixPaddingMs: { type: 'integer', minimum: 0, maximum: 2_000 },
        eagerness: { type: 'string', enum: ['low', 'medium', 'high', 'auto'] },
        languageMode: { type: 'string', enum: ['auto', 'session'], default: 'auto' },
        prompt: { type: 'string', maxLength: 2_000 },
        // The provider rejects a keyword containing <, >, a carriage return or a line feed.
        keywords: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^<>\\r\\n]+$' },
        },
        delay: { type: 'string', enum: [...REALTIME_STT_DELAYS] },
        noiseReduction: { type: 'string', enum: ['near_field', 'far_field'] },
        connectTimeoutMs: { type: 'integer', minimum: 500, maximum: 15_000, default: 6_000 },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: REALTIME_STT_CAPABILITIES,
    meters: [
      {
        key: OPENAI_REALTIME_STT_METER_KEY,
        unit: 'audio_seconds',
        label: 'OpenAI realtime transcription audio seconds',
        role: 'stt',
      },
    ],
    runtime: { egressHosts: [REALTIME_STT_HOST], modelLicences: [] },
    conformance: ['stt@1'],
    ui: {
      label: 'OpenAI Realtime Transcription STT',
      description: 'Streaming transcription over one WebSocket per call; 8 kHz μ-law in.',
      vendor: 'OpenAI',
      docsUrl: 'https://developers.openai.com/api/docs/guides/realtime-transcription',
      slot: 'stt',
      fields: {
        model: { widget: 'model', label: 'Model', help: 'gpt-live-transcribe streams partials.' },
        turnDetection: {
          label: 'Turn detection',
          help: 'Manual commits on local silence; select the energy VAD with it.',
        },
        languageMode: { label: 'Language', help: 'auto detects; session pins the agent language.' },
        keywords: {
          label: 'Keywords',
          help: 'Names and terms the caller may say.',
          advanced: true,
        },
        prompt: { advanced: true },
        delay: { advanced: true },
        noiseReduction: { label: 'Noise reduction', advanced: true },
        silenceDurationMs: { advanced: true },
        vadThreshold: { advanced: true },
        prefixPaddingMs: { advanced: true },
        eagerness: { advanced: true },
        connectTimeoutMs: { advanced: true },
      },
    },
  },
  async (ctx, row) => {
    const key = await ctx.secret('');
    ctx.provide(
      Cap.stt,
      new OpenAiRealtimeStt(ctx.net, key, (row.binding ?? {}) as OpenAiRealtimeSttBinding),
    );
  },
);

export const plugins = [openAiRealtimeSttPlugin];
