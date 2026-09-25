import type { MuteRule, SpeechKindV2 } from '@winsendotai/ovo-contracts';

export interface MuteView {
  botSpeaking: boolean;
  kind?: SpeechKindV2;
  toolRunning: boolean;
  firstSpeechComplete: boolean;
}

export function confirmationPrompt(view: MuteView, rules: readonly MuteRule[]): boolean {
  return rules.includes('during-confirmation') && view.botSpeaking && view.kind === 'confirmation';
}

export function speechMuted(view: MuteView, rules: readonly MuteRule[]): boolean {
  return view.toolRunning && rules.includes('during-tools') ||
    view.botSpeaking && (view.kind === 'disclosure' || rules.includes('always-while-speaking') ||
      rules.includes('first-speech') && !view.firstSpeechComplete ||
      rules.includes('until-first-complete') && !view.firstSpeechComplete);
}

export function canInterrupt(view: MuteView, rules: readonly MuteRule[]): boolean {
  return !speechMuted(view, rules) && !confirmationPrompt(view, rules);
}
