import type { CarrierCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';

/**
 * AGT-15: a transfer the agent can trigger must be one the carrier can carry out. Otherwise the
 * caller hears the transfer line and is hung up. Checked against the release's carrier and, at
 * live admission, the carrier the call actually arrived on. A target alone, with every trigger off,
 * transfers nothing and raises nothing.
 */
export const handoffCarrierUnsupported: CompatRule = (input, stage) => {
  const transfer = input.config.handoff?.transfer;
  if (
    !transfer ||
    !(
      transfer.nodes.length ||
      transfer.onDecisionUnavailable ||
      transfer.onRecoveryExhausted ||
      transfer.llmTool
    )
  )
    return [];
  const carrier = resolved(input).find((entry) => entry.slot === 'carrier');
  if (!carrier) return [];
  const capabilities = manifestKeys(carrier.definition.manifest).manifest
    .capabilities as CarrierCapabilities;
  return capabilities.control.handoff.includes(transfer.target.kind)
    ? []
    : [
        issue(
          'termination_unsupported',
          stage,
          `Selected carrier cannot transfer a call to a ${transfer.target.kind} target`,
          {
            slot: 'carrier',
            pluginId: carrier.choice.pluginId,
            field: 'handoff.transfer.target.kind',
          },
        ),
      ];
};
