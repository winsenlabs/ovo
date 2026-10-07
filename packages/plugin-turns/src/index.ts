import { Cap, type TurnDetectorFactory } from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { DetectorConfigSchema, type DetectorConfig } from './config.ts';
import { TurnController } from './controller.ts';

export {
  CommitConfigSchema,
  DetectorConfigSchema,
  PHONE_TURN_CONFIG,
  SpeechEvidenceConfigSchema,
  type DetectorConfig,
} from './config.ts';

export function createTurnDetector(row: unknown = {}): TurnDetectorFactory {
  const config: DetectorConfig = DetectorConfigSchema.parse(row);
  return { create: (input) => new TurnController(config, input) };
}

export const turnDetectorPlugin = definePluginV2(
  {
    id: '@winsendotai/ovo-turn-detector-default',
    version: '0.1.0',
    scope: 'session',
    kind: 'turn-detector',
    provider: 'ovo',
    provides: [Cap.turnDetector],
    config: DetectorConfigSchema,
    conformance: ['turn@1'],
  },
  (ctx, config) => {
    ctx.provide(Cap.turnDetector, createTurnDetector(config));
  },
);

export const plugins = [turnDetectorPlugin];
export const fixtures = {};
export const fixtureTemplates = {};
