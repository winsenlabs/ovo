import { Cap, type VadAnalyzerFactory } from '@winsendotai/ovo-contracts';
import { definePluginV2 } from '@winsendotai/ovo-sdk';
import { EnergyVadConfigSchema, sharedParams, type EnergyVadConfig } from './config.ts';
import { EnergyVad } from './energy-vad.ts';

export { EnergyVadConfigSchema, PHONE_VAD_CONFIG, type EnergyVadConfig } from './config.ts';

export function createEnergyVad(row: unknown = {}): VadAnalyzerFactory {
  const config: EnergyVadConfig = EnergyVadConfigSchema.parse(row);
  return { params: sharedParams(config), create: (rate) => new EnergyVad(rate, config) };
}

export const energyVadPlugin = definePluginV2(
  {
    id: '@winsendotai/ovo-vad-energy',
    version: '0.1.0',
    scope: 'session',
    kind: 'vad',
    provider: 'ovo',
    provides: [Cap.vad],
    config: EnergyVadConfigSchema,
    conformance: ['vad@1'],
  },
  (ctx, config) => {
    ctx.provide(Cap.vad, createEnergyVad(config));
  },
);

export const plugins = [energyVadPlugin];
export const fixtures = {};
export const fixtureTemplates = {};
