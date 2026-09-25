import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { CachedSpeechOutput } from './output.ts';
import {
  SPEECH_CACHE_PLUGIN_ID,
  SPEECH_CACHE_SERVICE_KEYS,
  type AudioPlayer,
  type NormalizedTts,
  type SpeechCacheOutputConfig,
  type SpeechCacheTelemetrySink,
} from './types.ts';

export function createSpeechCacheOutputPlugin(options: { emit?: SpeechCacheTelemetrySink } = {}) {
  return definePlugin(
    {
      id: SPEECH_CACHE_PLUGIN_ID,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [
        SPEECH_CACHE_SERVICE_KEYS.cache,
        SPEECH_CACHE_SERVICE_KEYS.tts,
        SPEECH_CACHE_SERVICE_KEYS.audioPlayer,
      ],
      provides: [SPEECH_CACHE_SERVICE_KEYS.output],
      configSchema: speechCacheConfigSchema,
      secretFields: [],
    },
    (ctx, config) => {
      const cache = ctx.get(SPEECH_CACHE_SERVICE_KEYS.cache) as ByteCache | undefined;
      const tts = ctx.get(SPEECH_CACHE_SERVICE_KEYS.tts) as NormalizedTts | undefined;
      const player = ctx.get(SPEECH_CACHE_SERVICE_KEYS.audioPlayer) as AudioPlayer | undefined;
      if (!cache || !tts || !player)
        throw new Error('Speech cache output dependencies are unavailable');
      ctx.provide(
        SPEECH_CACHE_SERVICE_KEYS.output,
        new CachedSpeechOutput(config as unknown as SpeechCacheOutputConfig, {
          cache,
          tts,
          player,
          emit: options.emit,
        }),
      );
    },
  );
}

const requiredStrings = [
  'workspaceId',
  'provider',
  'bindingVersion',
  'model',
  'voice',
  'locale',
  'codec',
  'pronunciation',
  'prosodyRevision',
  'optionsRevision',
] as const;

const speechCacheConfigSchema = {
  type: 'object',
  required: [...requiredStrings, 'sampleRate'],
  properties: {
    ...Object.fromEntries(requiredStrings.map((name) => [name, { type: 'string', minLength: 1 }])),
    sampleRate: { type: 'integer', minimum: 1, maximum: 384_000 },
    announcementMode: { type: 'boolean' },
    approvedPhrases: {
      type: 'array',
      maxItems: 1_000,
      items: {
        type: 'object',
        required: ['text', 'purpose'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 20_000 },
          purpose: { enum: ['static-phrase', 'announcement'] },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
