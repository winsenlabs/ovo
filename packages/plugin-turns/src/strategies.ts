import type { SpeechCapabilities, TurnConfig } from '@winsendotai/ovo-contracts';

export type StopStrategy = 'provider' | 'vad-timeout';

export function stopStrategy(
  config: TurnConfig,
  vad: boolean,
  stt?: SpeechCapabilities,
): StopStrategy {
  const strategy =
    config.strategy === 'auto' ? (vad ? 'vad-timeout' : 'provider') : config.strategy;
  if (
    strategy === 'provider' &&
    stt &&
    !stt.turnSignals.some((s) => s === 'end-of-turn' || s === 'utterance-end')
  )
    throw new Error('Provider turn strategy requires STT end-of-turn or utterance-end');
  return strategy;
}
