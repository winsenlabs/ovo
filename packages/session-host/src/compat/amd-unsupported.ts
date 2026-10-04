import type { CarrierCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const amdUnsupported: CompatRule = (input, stage) => {
  if (!input.amd) return [];
  const carrier = resolved(input).find((entry) => entry.slot === 'carrier');
  return carrier &&
    (manifestKeys(carrier.definition.manifest).manifest.capabilities as CarrierCapabilities).control
      .amd === 'none'
    ? [
        issue(
          'amd_unsupported',
          stage,
          'Selected carrier does not support answer machine detection',
          { slot: 'carrier' },
        ),
      ]
    : [];
};
