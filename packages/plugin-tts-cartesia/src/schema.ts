import {
  CARTESIA_VERSION,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_CONTEXTS,
  DEFAULT_MODEL,
  SONIC_EMOTIONS,
  SONIC_LANGUAGES,
  SONIC_MODELS,
} from './binding.ts';

/**
 * The binding schema. Ranges are the generation request's (`generation_config.volume` 0.5–2.0,
 * `speed` 0.6–1.5, `max_buffer_delay_ms` 0–5000) from
 * https://docs.cartesia.ai/api-reference/tts/websocket.md (retrieved 2026-10-13). `maxContexts`
 * tops out at Scale's 15 concurrent contexts
 * (https://docs.cartesia.ai/use-the-api/concurrency-limits-and-timeouts.md).
 */
export const CARTESIA_TTS_BINDING_SCHEMA = Object.freeze({
  type: 'object',
  required: ['voiceId'],
  properties: {
    model: { type: 'string', enum: [...SONIC_MODELS], default: DEFAULT_MODEL },
    voiceId: { type: 'string', minLength: 1, maxLength: 64 },
    language: { type: 'string', enum: [...SONIC_LANGUAGES] },
    normalization: { type: 'string', enum: ['auto', 'off', ...SONIC_LANGUAGES] },
    accent: { type: 'string', minLength: 1, maxLength: 64 },
    speed: { type: 'number', minimum: 0.6, maximum: 1.5 },
    volume: { type: 'number', minimum: 0.5, maximum: 2 },
    emotion: { type: 'string', enum: [...SONIC_EMOTIONS] },
    pronunciationDictId: { type: 'string', minLength: 1, maxLength: 128 },
    maxBufferDelayMs: { type: 'integer', minimum: 0, maximum: 5000, default: 0 },
    maxContexts: { type: 'integer', minimum: 1, maximum: 15, default: DEFAULT_MAX_CONTEXTS },
    connectTimeoutMs: {
      type: 'integer',
      minimum: 500,
      maximum: 10_000,
      default: DEFAULT_CONNECT_TIMEOUT_MS,
    },
    apiVersion: { type: 'string', const: CARTESIA_VERSION, default: CARTESIA_VERSION },
  },
  additionalProperties: false,
});

/** The plugin row: the binding and its credential reference, as the host composes them. */
export const CARTESIA_TTS_CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string' },
    bindingId: { type: 'string' },
    binding: { type: 'object' },
    credentialRef: { type: 'object' },
    updatedAt: { type: 'string' },
  },
});

export const CARTESIA_TTS_UI_FIELDS = {
  model: {
    widget: 'model',
    label: 'Model',
    help: 'The dated snapshot keeps cached clips stable; sonic-3.6 follows the alias.',
  },
  voiceId: {
    widget: 'voice',
    label: 'Voice ID',
    help: 'A Cartesia voice id that supports Sonic 3.6.',
  },
  language: {
    label: 'Language',
    help: 'Pins the spoken language, e.g. hi for Hinglish. Empty follows the agent language.',
  },
  normalization: {
    label: 'Text normalization',
    help: 'en-IN reads digits and dates the Indian English way; off skips it.',
  },
  accent: { advanced: true },
  speed: { label: 'Speed' },
  volume: { label: 'Volume' },
  emotion: { label: 'Emotion', advanced: true },
  pronunciationDictId: { label: 'Pronunciation dictionary', advanced: true },
  maxBufferDelayMs: { advanced: true },
  maxContexts: {
    label: 'Concurrent contexts',
    help: 'Per call. Keep at or below the plan limit (Pro 3, Startup 5, Scale 15).',
    advanced: true,
  },
  connectTimeoutMs: { advanced: true },
  apiVersion: { advanced: true },
} as const;
