import {
  classifyConfirmation,
  normalizeForMatch,
  type MuteRule,
  type SpeechKindV2,
} from '@winsendotai/ovo-contracts';

export interface GateState {
  bot?: { epoch: number; kind?: SpeechKindV2 };
  tools: number;
  rules: ReadonlySet<MuteRule>;
  botSegments: number;
  firstCompleted: boolean;
}

/** The §2.7 mute table: what happens to user speech right now. */
export function muteFor(state: GateState): 'discard' | 'buffer' | undefined {
  const { bot, rules } = state;
  if (bot?.kind === 'disclosure') return 'discard';
  if (state.tools > 0 && rules.has('during-tools')) return 'discard';
  if (bot?.kind === 'confirmation' && rules.has('during-confirmation')) return 'buffer';
  if (bot && rules.has('always-while-speaking')) return 'discard';
  if (bot && state.botSegments === 1 && rules.has('first-speech')) return 'discard';
  if (!state.firstCompleted && rules.has('until-first-complete')) return 'discard';
  return undefined;
}

/** A yes/no answer while a confirmation is pending (never a backchannel, never min-words dropped). */
export function isAnswer(confirmationPending: boolean, text: string): boolean {
  return confirmationPending && classifyConfirmation(text) !== 'unclear';
}

export function isBackchannel(
  backchannels: readonly string[],
  confirmationPending: boolean,
  text: string,
): boolean {
  if (isAnswer(confirmationPending, text)) return false;
  const normalized = normalizeForMatch(text);
  return backchannels.some((phrase) => normalizeForMatch(phrase) === normalized);
}
