import { Cap } from '@winsendotai/ovo-contracts';
import { systemClock } from '@winsendotai/ovo-plugin-kit';
import { definePlugin } from '@winsendotai/ovo-runtime';
import {
  DEFAULT_MODEL,
  DEFAULT_TONE,
  MAX_DESCRIPTION_CHARS,
  RUMIK_HOST,
  SPEAKERS,
  TONES,
  type RumikTtsBinding,
} from './binding.ts';
import { RUMIK_TTS_CAPABILITIES, RumikTts } from './tts.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  DEFAULT_MODEL,
  DEFAULT_TONE,
  MAX_DESCRIPTION_CHARS,
  MAX_TEXT_CHARS,
  RUMIK_HOST,
  SPEAKERS,
  TONES,
  cacheRevision,
  spokenText,
  type RumikModel,
  type RumikSpeaker,
  type RumikTone,
  type RumikTtsBinding,
} from './binding.ts';
export { RUMIK_TTS_CAPABILITIES, RumikTts } from './tts.ts';
export { RumikTtsError } from './errors.ts';
export { fixtures, fixtureTemplates };

/** The price-card key the cost runtime derives for this plugin's meter (`meterKey()`). */
export const RUMIK_TTS_METER_KEY = 'rumik.streaming-tts.characters';

export const rumikTtsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-tts-rumik',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'rumik',
    provides: [`${Cap.tts}@2`],
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
        model: { type: 'string', enum: ['mulberry', 'muga'], default: DEFAULT_MODEL },
        speaker: { type: 'string', enum: [...SPEAKERS] },
        description: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_DESCRIPTION_CHARS,
          pattern: '\\S',
        },
        defaultTone: { type: 'string', enum: [...TONES], default: DEFAULT_TONE },
        // Rumik documents defaults (0.6, 0.95, 50, 1.2, 2048) and the 8000-token clamp, not
        // ranges; these bounds are OVO's, to keep a binding inside sane sampling.
        temperature: { type: 'number', minimum: 0.1, maximum: 1.5 },
        topP: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
        topK: { type: 'integer', minimum: 1, maximum: 500 },
        repetitionPenalty: { type: 'number', minimum: 1, maximum: 2 },
        maxNewTokens: { type: 'integer', minimum: 64, maximum: 8000 },
        normalization: { type: 'boolean', default: false },
        transport: { type: 'string', enum: ['websocket', 'http'], default: 'websocket' },
        httpFallback: { type: 'boolean', default: true },
        connectTimeoutMs: { type: 'integer', minimum: 500, maximum: 10000, default: 3000 },
      },
      // mulberry (the default model) builds the voice from `description` on every request; without
      // one Rumik silently falls back to a generic voice (OpenAPI `TTSRequest.description`).
      if: { properties: { model: { const: 'mulberry' } } },
      then: { required: ['description'] },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: RUMIK_TTS_CAPABILITIES,
    meters: [
      { key: RUMIK_TTS_METER_KEY, unit: 'characters', label: 'Rumik TTS characters', role: 'tts' },
    ],
    runtime: { egressHosts: [RUMIK_HOST], modelLicences: [] },
    conformance: ['tts@1'],
    ui: {
      label: 'Rumik Silk Text to Speech',
      description: 'Hindi, English and Hinglish speech in native μ-law over a minted Silk socket.',
      vendor: 'Rumik',
      docsUrl: 'https://docs.rumik.ai/streaming',
      slot: 'tts',
      fields: {
        model: {
          widget: 'model',
          label: 'Model',
          help: 'mulberry streams fastest and needs a description; muga is steered by a [tone] tag.',
        },
        speaker: {
          widget: 'voice',
          label: 'Speaker',
          help: 'mulberry only. Optional named voice.',
        },
        description: {
          label: 'Voice description',
          help: 'mulberry only. Billed with every request, so keep it short (at most 300 characters).',
        },
        defaultTone: {
          label: 'Default tone',
          help: 'muga only. Prefixed to a sentence that does not start with a [tone] tag.',
        },
        topP: { advanced: true },
        topK: { advanced: true },
        repetitionPenalty: { advanced: true },
        maxNewTokens: { advanced: true },
        normalization: {
          label: "Rumik's text normalization",
          help: 'Off by default: OVO already writes replies for the ear.',
          advanced: true,
        },
        transport: { advanced: true },
        httpFallback: { advanced: true },
        connectTimeoutMs: { advanced: true },
      },
    },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as RumikTtsBinding;
    const ref = row.credentialRef;
    const apiKey = await ctx.secret(
      ref && typeof ref === 'object' && 'credentialRef' in ref ? '/credentialRef' : '',
    );
    const tts = new RumikTts(ctx.net, apiKey, binding, systemClock, ctx.logger);
    ctx.effect(() => () => tts.dispose());
    ctx.provide(Cap.tts, tts);
  },
);
export const plugins = [rumikTtsPlugin];
