import { Cap } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { SCRIBE_CAPABILITIES, SCRIBE_LANGUAGES } from './capabilities.ts';
import {
  ElevenLabsStt,
  SCRIBE_HOSTS,
  SCRIBE_MODELS,
  SCRIBE_REGIONS,
  type ElevenLabsSttBinding,
} from './provider.ts';
import { SCRIBE_MAX_KEYTERM_CHARS, SCRIBE_MAX_KEYTERMS } from './keyterms.ts';
import { fixtures, fixtureTemplates } from './testing.ts';

export {
  SCRIBE_CAPABILITIES,
  SCRIBE_LANGUAGES,
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
export { scribeKeyterms, type ScribeCallKeyterms } from './keyterms.ts';
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
        // STT-11, from the agent's `voice.stt.config`: terms every call favours, and the call
        // variables (paths such as `full_name`) whose values that call favours.
        keyterms: { type: 'array', maxItems: SCRIBE_MAX_KEYTERMS, items: { type: 'string' } },
        keytermVariables: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1 } },
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
        // N4/P9: the base code 'session' pins, the others the audio may hold, and logging of the
        // language the provider detects per commit.
        sessionLanguage: { type: 'string', enum: [...SCRIBE_LANGUAGES] },
        secondaryLanguages: {
          type: 'array',
          maxItems: 10,
          uniqueItems: true,
          items: { type: 'string', enum: [...SCRIBE_LANGUAGES] },
        },
        languageDetection: { type: 'boolean', default: false },
        // The provider accepts up to 50 keyterms of up to 20 characters each.
        keyterms: {
          type: 'array',
          maxItems: SCRIBE_MAX_KEYTERMS,
          items: { type: 'string', minLength: 1, maxLength: SCRIBE_MAX_KEYTERM_CHARS },
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
      new ElevenLabsStt(ctx.net, key, (row.binding ?? {}) as ElevenLabsSttBinding, undefined, {
        keyterms: row.keyterms as string[] | undefined,
        keytermVariables: row.keytermVariables as string[] | undefined,
      }),
    );
  },
);

export const plugins = [elevenLabsSttPlugin];
