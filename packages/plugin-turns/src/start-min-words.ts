import {
  CONFIRM_NO,
  CONFIRM_YES,
  classifyConfirmation,
  isBackchannel,
  normalizeForMatch,
  type TurnConfig,
} from '@winsendotai/ovo-contracts';

/** Re-run on every transcript revision, including late interims. */
export function speechCanInterrupt(
  text: string,
  language: string,
  config: Pick<TurnConfig, 'minWordsWhileBotSpeaking' | 'backchannels' | 'backchannelsEnabled'>,
  confirmationPending: boolean,
): boolean {
  if (!text.trim()) return false;
  if (
    confirmationPending &&
    (classifyConfirmation(text) !== 'unclear' || containsConfirmationPhrase(text))
  )
    return false;
  return !isBackchannel(text, language, config);
}

/**
 * True when `text`, said over the agent, only acknowledges it (AGT-9). A LAT-6 filler answers
 * nothing, so only a listed backchannel ("ok", "haan") acknowledges one: any other words, however
 * few, continue the caller's turn, as in silence.
 */
export function acknowledges(
  text: string,
  language: string,
  config: Pick<TurnConfig, 'minWordsWhileBotSpeaking' | 'backchannels' | 'backchannelsEnabled'>,
  filler = false,
): boolean {
  if (speechCanInterrupt(text, language, config, false)) return false;
  return !filler || isBackchannel(text, language, { ...config, minWordsWhileBotSpeaking: 0 });
}

export function containsConfirmationPhrase(text: string): boolean {
  const tokens = normalizeForMatch(text).split(' ').filter(Boolean);
  return [...CONFIRM_YES, ...CONFIRM_NO].some((phrase) => {
    const words = normalizeForMatch(phrase).split(' ');
    return tokens.some((_, i) => words.every((word, j) => tokens[i + j] === word));
  });
}
