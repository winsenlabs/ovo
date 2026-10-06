import type { SpeechCapabilities } from '@winsendotai/ovo-contracts';
import type { DetectorConfig } from './config.ts';

export type StopStrategy = 'provider' | 'vad-timeout' | 'commit';

export function stopStrategy(
  config: Pick<DetectorConfig, 'strategy'>,
  vad: boolean,
  stt?: SpeechCapabilities,
): StopStrategy {
  const strategy = config.strategy === 'auto' ? autoStrategy(vad, stt) : config.strategy;
  if (strategy === 'provider' && stt && !providerEnds(stt))
    throw new Error('Provider turn strategy requires STT end-of-turn or utterance-end');
  return strategy;
}

/**
 * A manual-commit STT never ends a turn on its own, so 'auto' commits for it even without a VAD:
 * the stalled-interim fallback still ends the turn, where 'provider' would refuse the session.
 */
function autoStrategy(vad: boolean, stt?: SpeechCapabilities): StopStrategy {
  if (stt?.forceEndpoint && !providerEnds(stt)) return 'commit';
  return vad ? 'vad-timeout' : 'provider';
}

function providerEnds(stt: SpeechCapabilities): boolean {
  return stt.turnSignals.some((s) => s === 'end-of-turn' || s === 'utterance-end');
}
