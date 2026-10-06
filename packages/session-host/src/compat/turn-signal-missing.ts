import type { SpeechCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const turnSignalMissing: CompatRule = (input, stage) => {
  if (input.turnStrategy !== 'provider' || input.selections?.vad) return [];
  const stt = resolved(input).find((entry) => entry.slot === 'stt');
  const capabilities =
    stt && (manifestKeys(stt.definition.manifest).manifest.capabilities as SpeechCapabilities);
  const signals = capabilities?.turnSignals ?? [];
  if (signals.includes('end-of-turn') || signals.includes('utterance-end')) return [];
  // A manual-commit STT finalises only when the host commits, which a VAD's silence triggers.
  const message = capabilities?.forceEndpoint
    ? `${stt!.choice.pluginId} finalises only on a host commit; select a VAD so the 'commit' turn strategy can end turns`
    : 'Provider turn detection requires an end-of-turn signal or VAD';
  return [issue('turn_signal_missing', stage, message, { slot: 'stt' })];
};
