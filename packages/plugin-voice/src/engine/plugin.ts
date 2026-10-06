import {
  Cap,
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  SESSION_INPUT_JSON_SCHEMA,
  type Behavior,
  type Clock,
  type MediaDuplex,
  type SessionInput,
  type SpeechToText,
  type TranscriptObserver,
  type TurnDetectorFactory,
  type TextFilter,
  type UsageSink,
  type VadAnalyzerFactory,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { BoundedSpeechScheduler } from '../scheduler.ts';
import { STREAMING_VOICE_PLUGIN_IDS } from '../production-plugins.ts';
import { VOICE_PLUGIN_IDS } from '../types.ts';
import { NativeVoiceSessionEngine } from './session-engine.ts';

const engineSchema = {
  type: 'object',
  properties: {
    prefetchSegments: { type: 'integer', minimum: 0, maximum: 4, default: 2 },
    maxPrefetchBytes: { type: 'integer', minimum: 1, maximum: 8_388_608, default: 262_144 },
    markTimeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
    // Raised to preSttBufferMs worth of 10 ms frames when lower; see ingress-backlog.ts.
    maxIngressFrames: { type: 'integer', minimum: 1, maximum: 1000 },
    maxIngressBytes: { type: 'integer', minimum: 1, maximum: 8_388_608 },
    maxConcurrentTurns: { type: 'integer', minimum: 1, maximum: 16 },
    preSttBufferMs: { type: 'integer', minimum: 1, maximum: 30_000, default: 15_000 },
  },
  additionalProperties: false,
} as const;

export const NATIVE_ENGINE_CAPABILITIES = {
  turnDetection: ['provider', 'vad-timeout'],
  bargeIn: true,
  dtmf: true,
  confirmedPlayback: true,
  ownsProviders: false,
  formats: [MULAW_8K, PCM16_8K, PCM16_16K],
  consumesTurnDetector: true,
} as const;

export function createNativeVoiceEngineV2Plugin() {
  return definePlugin(
    {
      id: STREAMING_VOICE_PLUGIN_IDS.sessionEngine,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'engine',
      provider: 'ovo-native',
      requires: [Cap.behavior, Cap.scheduler, Cap.media],
      optional: [
        Cap.stt,
        Cap.vad,
        Cap.turnDetector,
        Cap.textFilters,
        Cap.clock,
        Cap.usage,
        Cap.transcripts,
      ],
      provides: [Cap.engine + '@2'],
      companions: {
        [Cap.speech]: VOICE_PLUGIN_IDS.scheduler,
        [Cap.scheduler]: VOICE_PLUGIN_IDS.scheduler,
        [Cap.output]: STREAMING_VOICE_PLUGIN_IDS.mediaOutput,
      },
      configSchema: {
        type: 'object',
        required: ['session', 'engine'],
        properties: { session: SESSION_INPUT_JSON_SCHEMA, engine: engineSchema },
        additionalProperties: false,
      },
      secretFields: [],
      capabilities: NATIVE_ENGINE_CAPABILITIES,
      runtime: { egressHosts: [], modelLicences: [] },
      conformance: ['engine@1'],
    },
    (ctx, config) => {
      const engine = new NativeVoiceSessionEngine({
        behavior: ctx.get(Cap.behavior) as Behavior,
        scheduler: ctx.get(Cap.scheduler) as BoundedSpeechScheduler,
        media: ctx.get(Cap.media) as MediaDuplex,
        stt: ctx.maybe(Cap.stt) as SpeechToText | undefined,
        vad: ctx.maybe(Cap.vad) as VadAnalyzerFactory | undefined,
        turnDetector: ctx.maybe(Cap.turnDetector) as TurnDetectorFactory | undefined,
        clock: ctx.maybe(Cap.clock) as Clock | undefined,
        usage: ctx.maybe(Cap.usage) as UsageSink | undefined,
        transcripts: ctx.maybe(Cap.transcripts) as TranscriptObserver | undefined,
        textFilters: [...ctx.all(Cap.textFilters).values()] as TextFilter[],
        session: config.session as SessionInput,
        engine: config.engine as Record<string, number>,
      });
      ctx.provide(Cap.engine, engine);
      ctx.effect(() => () => engine.dispose('drain'));
    },
  );
}
