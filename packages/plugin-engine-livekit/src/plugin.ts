import {
  Cap,
  MULAW_8K,
  PCM16_8K,
  SESSION_INPUT_JSON_SCHEMA,
  type EngineCapabilities,
  type SessionInput,
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
    optional: [Cap.stt, Cap.vad, Cap.clock, Cap.usage, Cap.transcripts],
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
    capabilities: CAPABILITIES,
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
        session: config.session as SessionInput,
      },
      ctx.get(Cap.speech) as LiveKitSpeech,
      config.engine as LiveKitOptions,
    );
    ctx.provide(Cap.engine, engine);
    ctx.effect(() => () => engine.dispose('drain'));
  },
);
