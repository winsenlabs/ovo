import {
  CONFIRM_NO,
  CONFIRM_YES,
  classifyConfirmation,
  countWords,
  normalizeForMatch,
  type TurnConfig,
} from '@winsendotai/ovo-contracts';

/** Re-run on every transcript revision, including late interims. */
export function speechCanInterrupt(
  text: string,
  language: string,
  config: TurnConfig,
  confirmationPending: boolean,
): boolean {
  if (!text.trim()) return false;
  if (
    confirmationPending &&
    (classifyConfirmation(text) !== 'unclear' || containsConfirmationPhrase(text))
  )
    return false;
  if (countWords(text, language) < config.minWordsWhileBotSpeaking) return false;
  return !config.backchannels.some((word) => normalizeForMatch(word) === normalizeForMatch(text));
}

export function containsConfirmationPhrase(text: string): boolean {
  const tokens = normalizeForMatch(text).split(' ').filter(Boolean);
  return [...CONFIRM_YES, ...CONFIRM_NO].some((phrase) => {
    const words = normalizeForMatch(phrase).split(' ');
    return tokens.some((_, i) => words.every((word, j) => tokens[i + j] === word));
  });
}
