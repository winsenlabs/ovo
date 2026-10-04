import type { EngineCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const engineCapabilityMissing: CompatRule = (input, stage) => {
  const engine = resolved(input).find((entry) => entry.slot === 'engine');
  if (!engine) return [];
  const capabilities = manifestKeys(engine.definition.manifest).manifest
    .capabilities as EngineCapabilities;
  const needed = input.turnStrategy;
  return needed && !capabilities.turnDetection.includes(needed)
    ? [
        issue(
          'engine_capability_missing',
          stage,
          `Engine does not support ${needed} turn detection`,
          { slot: 'engine', pluginId: engine.choice.pluginId },
        ),
      ]
    : [];
};
