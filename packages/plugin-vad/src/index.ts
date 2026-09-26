import {
  Cap,
  VadParamsSchema,
  type VadAnalyzerFactory,
  type VadParams,
} from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { EnergyVad } from './energy-vad.ts';

export function createEnergyVad(row: unknown = {}): VadAnalyzerFactory {
  const params: VadParams = VadParamsSchema.parse(row);
  return { params, create: (rate) => new EnergyVad(rate, params) };
}

export const energyVadPlugin = definePluginV2(
  {
    id: '@winsendotai/ovo-vad-energy',
    version: '0.1.0',
    scope: 'session',
    kind: 'vad',
    provider: 'ovo',
    provides: [Cap.vad],
    config: VadParamsSchema,
    conformance: ['vad@1'],
  },
  (ctx, config) => {
    ctx.provide(Cap.vad, createEnergyVad(config));
  },
);

export const plugins = [energyVadPlugin];
export const fixtures = {};
export const fixtureTemplates = {};
