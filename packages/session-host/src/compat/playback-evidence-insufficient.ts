import type { CarrierCapabilities, EngineCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const playbackEvidenceInsufficient: CompatRule = (input, stage) => {
  if (input.config.voice?.acknowledgements.includes('weak-playback-evidence')) return [];
  if (!input.config.tools.some((tool) => tool.effect === 'write' && tool.confirmation)) return [];
  const entries = resolved(input);
  const carrier = entries.find((entry) => entry.slot === 'carrier');
  const engine = entries.find((entry) => entry.slot === 'engine');
  if (!carrier || !engine) return [];
  const evidence = (
    manifestKeys(carrier.definition.manifest).manifest.capabilities as CarrierCapabilities
  ).media.playbackEvidence;
  const confirmed = (
    manifestKeys(engine.definition.manifest).manifest.capabilities as EngineCapabilities
  ).confirmedPlayback;
  return evidence === 'carrier-played' && confirmed
    ? []
    : [
        issue(
          'playback_evidence_insufficient',
          stage,
          'Confirmed write tools require carrier playback evidence and engine confirmation',
          { slot: 'carrier' },
        ),
      ];
};
