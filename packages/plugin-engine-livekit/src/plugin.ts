import {
  Cap,
  MULAW_8K,
  PCM16_8K,
  SESSION_INPUT_JSON_SCHEMA,
  type EngineCapabilities,
  type SessionInput,
  type TextFilter,
} from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { systemClock } from '@winsendotai/ovo-plugin-kit';
import { LiveKitSpeech } from './speech.ts';
import type { LiveKitOptions, LiveKitPorts } from './types.ts';

export const ENGINE_ID = '@winsendotai/ovo-engine-livekit';
export const CAPABILITIES: EngineCapabilities = {
  turnDetection: ['stt'],
  bargeIn: true,
  dtmf: true,
  confirmedPlayback: true,
  ownsProviders: false,
  formats: [MULAW_8K, PCM16_8K],
  consumesTurnDetector: false,
};
/**
 * Agent settings this engine does not honour, for the host's `engine_capability_missing` check.
 * Each degrades a call rather than breaking it, so each is a warning (see README, TTS-14).
 */
export const LIVEKIT_UNSUPPORTED_AGENT_FEATURES = [
  {
    path: 'speechCache.enabled',
    severity: 'warning',
    message:
      'The LiveKit engine synthesises every line live: pre-rendered and per-call clips are not used',
  },
  {
    path: 'voice.turnDetector.config.filler',
    severity: 'warning',
    message: 'The LiveKit engine plays no filler line on a slow reply (LAT-6)',
  },
] as const;

const MANIFEST_CAPABILITIES: EngineCapabilities & {
  unsupportedAgentFeatures: typeof LIVEKIT_UNSUPPORTED_AGENT_FEATURES;
} = { ...CAPABILITIES, unsupportedAgentFeatures: LIVEKIT_UNSUPPORTED_AGENT_FEATURES };

export const speechPlugin = definePlugin(
  {
    id: `${ENGINE_ID}/speech`,
    version: '0.1.0',
    contractVersion: 2,
    kind: 'infra',
    scope: 'session',
    provides: [Cap.speech],
    requires: [],
    configSchema: { type: 'object' },
    secretFields: [],
  },
  (ctx) => {
    const speech = new LiveKitSpeech();
    ctx.provide(Cap.speech, speech);
    ctx.effect(() => () => speech.close());
  },
);
export const enginePlugin = definePlugin(
  {
    id: ENGINE_ID,
    version: '0.1.0',
    contractVersion: 2,
    kind: 'engine',
    provider: 'livekit',
    scope: 'session',
    provides: [`${Cap.engine}@2`],
    requires: [Cap.behavior, Cap.media, Cap.tts, Cap.speech],
    optional: [Cap.stt, Cap.vad, Cap.clock, Cap.usage, Cap.transcripts, Cap.textFilters],
    companions: { [Cap.speech]: `${ENGINE_ID}/speech` },
    configSchema: {
      type: 'object',
      required: ['session', 'engine'],
      properties: {
        session: SESSION_INPUT_JSON_SCHEMA,
        engine: {
          type: 'object',
          properties: {
            minInterruptionWords: { type: 'integer', minimum: 1, default: 2 },
            closeDeadlineMs: { type: 'integer', minimum: 1, default: 2000 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    secretFields: [],
    capabilities: MANIFEST_CAPABILITIES,
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['engine@1'],
  },
  async (ctx, config) => {
    const { LiveKitEngine } = await import('./session-runner.ts');
    const engine = new LiveKitEngine(
      {
        media: ctx.get(Cap.media) as LiveKitPorts['media'],
        behavior: ctx.get(Cap.behavior) as LiveKitPorts['behavior'],
        tts: ctx.get(Cap.tts) as LiveKitPorts['tts'],
        stt: ctx.maybe(Cap.stt) as LiveKitPorts['stt'],
        clock: (ctx.maybe(Cap.clock) as LiveKitPorts['clock'] | undefined) ?? systemClock,
        usage: (ctx.maybe(Cap.usage) as LiveKitPorts['usage'] | undefined) ?? (() => {}),
        transcripts: ctx.maybe(Cap.transcripts) as LiveKitPorts['transcripts'],
        textFilters: [...ctx.all(Cap.textFilters).values()] as TextFilter[],
        session: config.session as SessionInput,
      },
      ctx.get(Cap.speech) as LiveKitSpeech,
      config.engine as LiveKitOptions,
    );
    ctx.provide(Cap.engine, engine);
    ctx.effect(() => () => engine.dispose('drain'));
  },
);
