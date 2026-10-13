import {
  DEFAULT_BACKLOG_MAX_RATE,
  DEFAULT_CONNECT_TIMEOUT_MS,
  MAX_KEYTERM_CHARS,
  MAX_KEYTERMS,
  TURN_RANGES,
  WHISPER_LANGUAGES,
} from './binding.ts';

// Ranges from https://docs.cartesia.ai/api-reference/stt/turns/websocket.md and
// https://docs.cartesia.ai/api-reference/stt/websocket.md (retrieved 2026-10-13). The 1200-character
// total and the threshold order are checked when the plugin is built (`callKeyterms`, `checkTurn`).

const range = ([minimum, maximum]: readonly [number, number]) => ({ minimum, maximum });

const shared = {
  keyterms: {
    type: 'array',
    maxItems: MAX_KEYTERMS,
    items: { type: 'string', minLength: 1, maxLength: MAX_KEYTERM_CHARS },
  },
  // Two attempts fit the worker's fifteen-second pre-session buffer.
  connectTimeoutMs: {
    type: 'integer',
    minimum: 500,
    maximum: 15_000,
    default: DEFAULT_CONNECT_TIMEOUT_MS,
  },
  backlogMaxRate: { type: 'number', minimum: 1, maximum: 4, default: DEFAULT_BACKLOG_MAX_RATE },
} as const;

export const CARTESIA_AUTO_BINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', const: 'ink-2', default: 'ink-2' },
    endpointing: { type: 'string', enum: ['fast', 'balanced', 'patient'] },
    turnStartThreshold: { type: 'number', ...range(TURN_RANGES.startThreshold) },
    turnEagerEndThreshold: { type: 'number', ...range(TURN_RANGES.eagerEndThreshold) },
    turnEndThreshold: { type: 'number', ...range(TURN_RANGES.endThreshold) },
    turnEndTimeoutMs: { type: 'integer', ...range(TURN_RANGES.endTimeoutMs) },
    ...shared,
  },
} as const;

const WHISPER_ONLY = ['language', 'minVolume', 'maxSilenceDurationSecs'] as const;

export const CARTESIA_MANUAL_BINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', enum: ['ink-2', 'ink-whisper'], default: 'ink-2' },
    language: { type: 'string', enum: [...WHISPER_LANGUAGES] },
    minVolume: { type: 'number', minimum: 0, maximum: 1 },
    maxSilenceDurationSecs: { type: 'number', exclusiveMinimum: 0, maximum: 30 },
    ...shared,
  },
  // ink-whisper needs `language` and takes no keyterms; ink-2 takes none of the whisper fields.
  allOf: [
    {
      if: { properties: { model: { const: 'ink-whisper' } }, required: ['model'] },
      then: { required: ['language'], not: { required: ['keyterms'] } },
      else: { not: { anyOf: WHISPER_ONLY.map((field) => ({ required: [field] })) } },
    },
  ],
} as const;

/** The plugin row: binding, credential reference and the agent's STT keyterms. */
export const CARTESIA_STT_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    workspaceId: { type: 'string' },
    bindingId: { type: 'string' },
    binding: { type: 'object' },
    credentialRef: { type: 'object' },
    updatedAt: { type: 'string' },
    keyterms: { type: 'array', maxItems: MAX_KEYTERMS, items: { type: 'string' } },
  },
} as const;

const KEYTERMS_FIELD = {
  label: 'Keyterms',
  help: 'Up to 100 terms, 1200 characters in total, fixed for the call. ink-2 only.',
} as const;
const COMMON_FIELDS = {
  keyterms: KEYTERMS_FIELD,
  connectTimeoutMs: { advanced: true },
  backlogMaxRate: {
    label: 'Backlog pace',
    help: 'How fast buffered caller audio is replayed after connecting, as a multiple of real time.',
    advanced: true,
  },
} as const;

export const CARTESIA_AUTO_UI_FIELDS = {
  model: { widget: 'model', label: 'Model' },
  endpointing: {
    label: 'Endpointing',
    help: "Cartesia's Responsive, Balanced or Patient turn profile.",
  },
  turnStartThreshold: { advanced: true },
  turnEagerEndThreshold: { advanced: true },
  turnEndThreshold: { advanced: true },
  turnEndTimeoutMs: { advanced: true },
  ...COMMON_FIELDS,
} as const;

export const CARTESIA_MANUAL_UI_FIELDS = {
  model: {
    widget: 'model',
    label: 'Model',
    help: 'ink-whisper covers Tamil, Telugu and other Indic languages.',
  },
  language: { label: 'Language', help: 'ISO 639-1; ink-whisper only, and required for it.' },
  minVolume: { advanced: true },
  maxSilenceDurationSecs: { advanced: true },
  ...COMMON_FIELDS,
} as const;
