import type { TurnConfig } from '@winsendotai/ovo-contracts';

export function vadStartsTurn(botSpeaking: boolean, muted: boolean, config: TurnConfig): boolean {
  return !muted && (!botSpeaking || config.minWordsWhileBotSpeaking === 0);
}
