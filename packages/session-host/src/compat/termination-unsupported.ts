import type { CarrierCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const terminationUnsupported: CompatRule = (input, stage) => {
  const carrier = resolved(input).find((entry) => entry.slot === 'carrier');
  if (!carrier) return [];
  const capabilities = manifestKeys(carrier.definition.manifest).manifest
    .capabilities as CarrierCapabilities;
  const binding =
    carrier.choice.binding?.config ??
    (carrier.choice.bindingId ? input.bindings?.[carrier.choice.bindingId]?.config : undefined);
  return capabilities.control.hangup === 'close-stream' && binding?.streamEndTerminatesCall !== true
    ? [
        issue(
          'termination_unsupported',
          stage,
          'Close-stream hangup requires a binding attestation',
          { slot: 'carrier', pluginId: carrier.choice.pluginId, field: 'streamEndTerminatesCall' },
        ),
      ]
    : [];
};
