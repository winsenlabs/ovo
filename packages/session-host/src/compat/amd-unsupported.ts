import type { CarrierCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * A campaign that requires detection is blocked on a carrier without it. An agent's own voicemail
 * policy only warns: its outbound calls still connect, but the opening plays without waiting for a
 * verdict and a machine is never detected.
 */
export const amdUnsupported: CompatRule = (input, stage) => {
  const authored = input.config.mode === 'agent' && input.config.voicemail?.detect === true;
  if (!input.amd && !authored) return [];
  const carrier = resolved(input).find((entry) => entry.slot === 'carrier');
  return carrier &&
    (manifestKeys(carrier.definition.manifest).manifest.capabilities as CarrierCapabilities).control
      .amd === 'none'
    ? [
        issue(
          'amd_unsupported',
          stage,
          input.amd
            ? 'Selected carrier does not support answer machine detection'
            : 'Selected carrier does not support answer machine detection; the voicemail policy is ignored',
          { slot: 'carrier' },
          input.amd ? 'error' : 'warning',
        ),
      ]
    : [];
};
