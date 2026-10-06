import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { DEFAULT_MODEL, DEFAULT_VOICE_ID, REGION_HOSTS } from './binding.ts';
import { ELEVENLABS_TTS_CAPABILITIES, ElevenLabsTts } from './tts.ts';
import type { ElevenLabsTtsBinding } from './binding.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  DEFAULT_MODEL,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_SETTINGS,
  REGION_HOSTS,
  cacheRevision,
  multiStreamUrl,
  outputFormat,
  streamUrl,
  type ElevenLabsTtsBinding,
  type ElevenLabsTtsModel,
} from './binding.ts';
export { ELEVENLABS_TTS_CAPABILITIES, ElevenLabsTts } from './tts.ts';
export { ElevenLabsTtsError } from './errors.ts';
export { MAX_CONTEXTS } from './connection.ts';
export { fixtures, fixtureTemplates };

/** The price-card key the cost runtime derives for this plugin's meter. */
export const ELEVENLABS_TTS_METER_KEY = 'elevenlabs.streaming-tts.characters';

const unit = { type: 'number', minimum: 0, maximum: 1 } as const;

export const elevenLabsTtsPlugin = definePlugin(
  {
    id: '@winsendotai/ovo-tts-elevenlabs',
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'tts',
    provider: 'elevenlabs',
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
        model: {
          type: 'string',
          enum: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'],
          default: DEFAULT_MODEL,
        },
        voiceId: { type: 'string', minLength: 1, maxLength: 64, default: DEFAULT_VOICE_ID },
        stability: { ...unit, default: 0.5 },
        similarityBoost: { ...unit, default: 0.8 },
        style: unit,
        speed: { type: 'number', minimum: 0.7, maximum: 1.2, default: 1 },
        useSpeakerBoost: { type: 'boolean' },
        languageCode: { type: 'string', pattern: '^[a-z]{2,3}$' },
        applyTextNormalization: { type: 'string', enum: ['auto', 'on', 'off'] },
        seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
        pronunciationDictionaries: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string', minLength: 1 },
              versionId: { type: 'string', minLength: 1 },
            },
            additionalProperties: false,
          },
        },
        autoMode: { type: 'boolean', default: true },
        chunkLengthSchedule: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'integer', minimum: 50, maximum: 500 },
        },
        region: { type: 'string', enum: Object.keys(REGION_HOSTS), default: 'global' },
        transport: { type: 'string', enum: ['websocket', 'http'], default: 'websocket' },
        inactivityTimeoutS: { type: 'integer', minimum: 5, maximum: 180, default: 180 },
        connectTimeoutMs: { type: 'integer', minimum: 500, maximum: 10000, default: 3000 },
        httpFallback: { type: 'boolean', default: true },
        replyStream: { type: 'boolean', default: true },
        enableLogging: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    secretFields: [''],
    capabilities: ELEVENLABS_TTS_CAPABILITIES,
    meters: [
      {
        key: ELEVENLABS_TTS_METER_KEY,
        unit: 'characters',
        label: 'ElevenLabs TTS characters',
        role: 'tts',
      },
    ],
    runtime: { egressHosts: Object.values(REGION_HOSTS), modelLicences: [] },
    conformance: ['tts@1'],
    ui: {
      label: 'ElevenLabs Text to Speech',
      description: 'Streaming μ-law speech over one pooled multi-context socket per call.',
      vendor: 'ElevenLabs',
      docsUrl:
        'https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input',
      slot: 'tts',
      fields: {
        model: { widget: 'model', label: 'Model', help: 'Flash v2.5 has the lowest latency.' },
        voiceId: {
          widget: 'voice',
          label: 'Voice ID',
          help: 'Defaults to Monika Sogam (ZUrEGyu8GFMwnHbvLhv2).',
        },
        similarityBoost: { label: 'Similarity boost' },
        useSpeakerBoost: { label: 'Speaker boost' },
        languageCode: {
          label: 'Language code',
          help: 'ISO 639-1, e.g. hi. Leave empty to let the model detect the language.',
        },
        applyTextNormalization: { label: 'Text normalization', advanced: true },
        seed: { advanced: true },
        pronunciationDictionaries: {
          label: 'Pronunciation dictionaries',
          help: 'Up to three dictionaries, by ID and version, for lender and product names.',
        },
        autoMode: { advanced: true },
        chunkLengthSchedule: { advanced: true },
        region: { label: 'Region', advanced: true },
        transport: { advanced: true },
        inactivityTimeoutS: { advanced: true },
        connectTimeoutMs: { advanced: true },
        httpFallback: { advanced: true },
        replyStream: {
          label: 'One context per reply',
          help: 'Renders every sentence of a reply in one streaming context.',
          advanced: true,
        },
        enableLogging: { advanced: true },
      },
    },
  },
  async (ctx, row) => {
    const binding = (row.binding ?? {}) as ElevenLabsTtsBinding;
    const ref = row.credentialRef;
    const apiKey = await ctx.secret(
      ref && typeof ref === 'object' && 'credentialRef' in ref ? '/credentialRef' : '',
    );
    const tts = new ElevenLabsTts(ctx.net, apiKey, binding);
    ctx.effect(() => () => tts.dispose());
    ctx.provide(Cap.tts, tts);
  },
);
export const plugins = [elevenLabsTtsPlugin];
