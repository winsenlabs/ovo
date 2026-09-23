import {
  Cap,
  type Behavior,
  type MediaDuplex,
  type TextToSpeech,
} from '@winsendotai/ovo-contracts';
import { legacyFromDuplex, ttsAsLegacy } from '../../plugin-kit/src/speech-shims.ts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { StreamingMediaSpeechOutput } from './media-output.ts';
import type {
  StreamingStt,
  StreamingTts,
  TranscriptRevision,
  VoiceMediaTransport,
} from './provider-types.ts';
import { BoundedSpeechScheduler } from './scheduler.ts';
import { VoiceSessionEngine } from './session-engine.ts';
import { VOICE_SERVICE_KEYS } from './types.ts';

export const STREAMING_VOICE_SERVICE_KEYS = Object.freeze({
  behavior: 'ovo.behavior',
  stt: 'ovo.stt',
  tts: 'ovo.tts-streaming',
  media: 'ovo.media.duplex',
  sessionEngine: 'ovo.voice-session-engine',
});

export const STREAMING_VOICE_PLUGIN_IDS = Object.freeze({
  mediaOutput: '@winsendotai/ovo-plugin-speech-output-media',
  sessionEngine: '@winsendotai/ovo-plugin-voice-session-engine',
});

export interface VoiceSessionEnginePluginOptions {
  stt?: 'required' | 'optional' | 'disabled';
  onAcceptedTranscript?: (revision: Readonly<TranscriptRevision>) => void;
}

export function createStreamingMediaSpeechOutputPlugin(options: { source?: 'legacy' | 'v2' } = {}) {
  return definePlugin(
    {
      id: STREAMING_VOICE_PLUGIN_IDS.mediaOutput,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires:
        options.source === 'v2'
          ? [Cap.tts, Cap.media]
          : [STREAMING_VOICE_SERVICE_KEYS.tts, STREAMING_VOICE_SERVICE_KEYS.media],
      provides: [VOICE_SERVICE_KEYS.output],
      configSchema: {
        type: 'object',
        properties: {
          voice: { type: 'string', minLength: 1, maxLength: 120 },
          markTimeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
          allowWeakEvidence: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, config) => {
      const media =
        options.source === 'v2'
          ? required<MediaDuplex>(ctx.get(Cap.media), 'media duplex')
          : undefined;
      const output = new StreamingMediaSpeechOutput(
        media
          ? ttsAsLegacy(required<TextToSpeech>(ctx.get(Cap.tts), 'text to speech'))
          : required<StreamingTts>(ctx.get(STREAMING_VOICE_SERVICE_KEYS.tts), 'streaming TTS'),
        media
          ? legacyFromDuplex(media)
          : required<VoiceMediaTransport>(
              ctx.get(STREAMING_VOICE_SERVICE_KEYS.media),
              'media transport',
            ),
        {
          voice: typeof config.voice === 'string' ? config.voice : undefined,
          markTimeoutMs:
            typeof config.markTimeoutMs === 'number' ? config.markTimeoutMs : undefined,
          playbackEvidence: media?.playbackEvidence,
          allowWeakEvidence: config.allowWeakEvidence === true,
        },
      );
      ctx.provide(VOICE_SERVICE_KEYS.output, output);
      ctx.effect(() => () => output.dispose());
    },
  );
}

export function createVoiceSessionEnginePlugin(options: VoiceSessionEnginePluginOptions = {}) {
  const sttMode = options.stt ?? 'required';
  return definePlugin(
    {
      id: STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [
        STREAMING_VOICE_SERVICE_KEYS.behavior,
        VOICE_SERVICE_KEYS.scheduler,
        STREAMING_VOICE_SERVICE_KEYS.media,
        ...(sttMode === 'required' ? [STREAMING_VOICE_SERVICE_KEYS.stt] : []),
      ],
      provides: [STREAMING_VOICE_SERVICE_KEYS.sessionEngine],
      configSchema: {
        type: 'object',
        required: sttMode === 'required' ? ['language'] : [],
        properties: {
          language: { type: 'string', minLength: 2, maxLength: 32 },
          inputEnabled: { type: 'boolean' },
          initialInput: { type: 'string', maxLength: 10000 },
          initialVariables: { type: 'object', maxProperties: 200 },
          maxIngressFrames: { type: 'integer', minimum: 1, maximum: 1000 },
          maxIngressBytes: { type: 'integer', minimum: 1, maximum: 8388608 },
          maxConcurrentTurns: { type: 'integer', minimum: 1, maximum: 16 },
          maxStreamingSegmentsAhead: { type: 'integer', minimum: 1, maximum: 8 },
          minBargeInCharacters: { type: 'integer', minimum: 1, maximum: 100 },
          backchannels: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 100 } },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    async (ctx, config) => {
      const inputEnabled =
        typeof config.inputEnabled === 'boolean' ? config.inputEnabled : sttMode !== 'disabled';
      if (sttMode === 'disabled' && inputEnabled)
        throw new Error('Voice input cannot be enabled by an STT-disabled engine plugin');
      const stt =
        sttMode === 'disabled'
          ? undefined
          : (ctx.get(STREAMING_VOICE_SERVICE_KEYS.stt) as StreamingStt | undefined);
      const engine = new VoiceSessionEngine(
        required<Behavior>(ctx.get(STREAMING_VOICE_SERVICE_KEYS.behavior), 'behavior'),
        required<BoundedSpeechScheduler>(ctx.get(VOICE_SERVICE_KEYS.scheduler), 'speech scheduler'),
        sttMode === 'required' ? required<StreamingStt>(stt, 'streaming STT') : stt,
        required<VoiceMediaTransport>(
          ctx.get(STREAMING_VOICE_SERVICE_KEYS.media),
          'media transport',
        ),
        {
          language: typeof config.language === 'string' ? config.language : undefined,
          inputEnabled,
          initialInput: typeof config.initialInput === 'string' ? config.initialInput : undefined,
          initialVariables:
            config.initialVariables && typeof config.initialVariables === 'object'
              ? (config.initialVariables as Record<string, unknown>)
              : undefined,
          maxIngressFrames:
            typeof config.maxIngressFrames === 'number' ? config.maxIngressFrames : undefined,
          maxIngressBytes:
            typeof config.maxIngressBytes === 'number' ? config.maxIngressBytes : undefined,
          maxConcurrentTurns:
            typeof config.maxConcurrentTurns === 'number' ? config.maxConcurrentTurns : undefined,
          maxStreamingSegmentsAhead:
            typeof config.maxStreamingSegmentsAhead === 'number'
              ? config.maxStreamingSegmentsAhead
              : undefined,
          minBargeInCharacters:
            typeof config.minBargeInCharacters === 'number'
              ? config.minBargeInCharacters
              : undefined,
          backchannels: Array.isArray(config.backchannels)
            ? config.backchannels.filter((value): value is string => typeof value === 'string')
            : undefined,
        },
        { onAcceptedTranscript: options.onAcceptedTranscript },
      );
      await engine.start();
      ctx.provide(STREAMING_VOICE_SERVICE_KEYS.sessionEngine, engine);
      ctx.effect(() => () => engine.dispose());
    },
  );
}

function required<T>(value: unknown, label: string): T {
  if (!value) throw new Error(`Missing ${label}`);
  return value as T;
}
