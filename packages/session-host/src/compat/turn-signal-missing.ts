import type { SpeechCapabilities } from '@winsendotai/ovo-contracts';
import { manifestKeys } from '@winsendotai/ovo-runtime';
import type { CompatRule } from './types.ts';
import { issue, resolved } from './types.ts';
export const turnSignalMissing: CompatRule = (input, stage) => {
  if (input.turnStrategy !== 'provider' || input.selections?.vad) return [];
  const stt = resolved(input).find((entry) => entry.slot === 'stt');
  const signals =
    (stt && (manifestKeys(stt.definition.manifest).manifest.capabilities as SpeechCapabilities))
      ?.turnSignals ?? [];
  return signals.includes('end-of-turn') || signals.includes('utterance-end')
    ? []
    : [
        issue(
          'turn_signal_missing',
          stage,
          'Provider turn detection requires an end-of-turn signal or VAD',
          { slot: 'stt' },
        ),
      ];
};
