import { definePlugin } from '@winsendotai/ovo-runtime';
import { BoundedSpeechScheduler } from './scheduler.ts';
import { SimulatedSpeechOutput } from './simulated-output.ts';
import {
  VOICE_SERVICE_KEYS,
  VOICE_PLUGIN_IDS,
  type SimulatedSpeechOutputConfig,
  type SpeechOutput,
  type SpeechSchedulerConfig,
} from './types.ts';

const schedulerConfigSchema = {
  type: 'object',
  properties: {
    maxQueuedSegments: { type: 'integer', minimum: 1, maximum: 1_000 },
    maxQueuedCharacters: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    maxEvidenceEntries: { type: 'integer', minimum: 4, maximum: 10_000 },
    playbackTimeoutMs: { type: 'integer', minimum: 1, maximum: 300_000 },
  },
  additionalProperties: false,
} as const;

export function createSpeechSchedulerPlugin() {
  return definePlugin(
    {
      id: VOICE_PLUGIN_IDS.scheduler,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [VOICE_SERVICE_KEYS.output],
      provides: [VOICE_SERVICE_KEYS.speech, VOICE_SERVICE_KEYS.scheduler],
      configSchema: schedulerConfigSchema,
      secretFields: [],
    },
    (ctx, config) => {
      const output = ctx.get(VOICE_SERVICE_KEYS.output) as SpeechOutput | undefined;
      if (!output) throw new Error(`Missing ${VOICE_SERVICE_KEYS.output}`);
      const scheduler = new BoundedSpeechScheduler(output, parseSchedulerConfig(config));
      ctx.provide(VOICE_SERVICE_KEYS.speech, scheduler);
      ctx.provide(VOICE_SERVICE_KEYS.scheduler, scheduler);
      ctx.effect(() => () => scheduler.dispose());
    },
  );
}

export function createSimulatedSpeechOutputPlugin() {
  return definePlugin(
    {
      id: VOICE_PLUGIN_IDS.simulatedOutput,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [],
      provides: [VOICE_SERVICE_KEYS.output],
      configSchema: {
        type: 'object',
        properties: {
          latencyMs: { type: 'integer', minimum: 0, maximum: 60_000 },
          evidence: { enum: ['simulated', 'estimated', 'confirmed'] },
        },
        additionalProperties: false,
      },
      secretFields: [],
    },
    (ctx, config) => {
      ctx.provide(
        VOICE_SERVICE_KEYS.output,
        new SimulatedSpeechOutput(parseSimulatedOutputConfig(config)),
      );
    },
  );
}

export function createSimulatedVoicePluginCatalog() {
  return [createSimulatedSpeechOutputPlugin(), createSpeechSchedulerPlugin()] as const;
}

function parseSchedulerConfig(config: Record<string, unknown>): SpeechSchedulerConfig {
  assertKnownKeys(config, [
    'maxQueuedSegments',
    'maxQueuedCharacters',
    'maxEvidenceEntries',
    'playbackTimeoutMs',
  ]);
  return config as SpeechSchedulerConfig;
}

function parseSimulatedOutputConfig(config: Record<string, unknown>): SimulatedSpeechOutputConfig {
  assertKnownKeys(config, ['latencyMs', 'evidence']);
  if (
    config.latencyMs !== undefined &&
    (!Number.isInteger(config.latencyMs) ||
      Number(config.latencyMs) < 0 ||
      Number(config.latencyMs) > 60_000)
  ) {
    throw new TypeError('latencyMs must be an integer between 0 and 60000');
  }
  if (
    config.evidence !== undefined &&
    !['simulated', 'estimated', 'confirmed'].includes(String(config.evidence))
  ) {
    throw new TypeError('evidence must be simulated, estimated, or confirmed');
  }
  return config as SimulatedSpeechOutputConfig;
}

function assertKnownKeys(config: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(config).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`Unknown voice plugin config field: ${unknown}`);
}
