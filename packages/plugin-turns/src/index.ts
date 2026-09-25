import { Cap, TurnConfigSchema, type TurnDetectorFactory, type TurnConfig } from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { TurnController } from './controller.ts';

export function createTurnDetector(row: unknown = {}): TurnDetectorFactory {
  const config: TurnConfig = TurnConfigSchema.parse(row);
  return { create: (input) => new TurnController(config, input) };
}

export const turnDetectorPlugin = definePluginV2({
  id: '@winsendotai/ovo-turn-detector-default', version: '0.1.0', scope: 'session',
  kind: 'turn-detector', provider: 'ovo', provides: [Cap.turnDetector],
  config: TurnConfigSchema, conformance: ['turn@1'],
}, (ctx, config) => { ctx.provide(Cap.turnDetector, createTurnDetector(config)); });

export const plugins = [turnDetectorPlugin];
export const fixtures = {};
export const fixtureTemplates = {};
