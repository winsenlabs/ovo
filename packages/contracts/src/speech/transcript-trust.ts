import { CONFIRM_NO, CONFIRM_YES, countWords, normalizeForMatch } from '../text.ts';

/**
 * Why a caller turn's words should not be acted on as heard (Wave 8, call 6e1a4e3a in a noisy
 * cafe): `low-confidence`, the STT doubted its own words; `low-information`, seconds of "speech"
 * gave a word or two ("Hardik?" after 9.4 s of cafe noise held the VAD open); `fragment`, a few
 * words trailing off into an ellipsis ("Credit. Okay, so...", "Hello, if madam...").
 */
export type TranscriptDoubt = 'low-confidence' | 'low-information' | 'fragment';

/** What the turn detector knows about a caller turn's words when it ends the turn. */
export interface TranscriptEvidence {
  text: string;
  language: string;
  /**
   * The lowest `TranscriptSegment.confidence` among the turn's finals, 0 to 1, when the STT gives
   * one (Scribe: the geometric mean of the commit's word probabilities).
   */
  confidence?: number;
  /** How long the turn was open as speech, from its first voice to the end of speech, in ms. */
  spokenMs?: number;
}

export interface TranscriptTrustThresholds {
  /** Below this confidence the words are doubted. */
  minConfidence: number;
  /** A turn spoken at least this long... */
  lowInformationMs: number;
  /** ...that yields fewer words per second than this is mostly noise. */
  minWordsPerSecond: number;
  /** An ellipsis-ended turn of at most this many words is a fragment. */
  fragmentWords: number;
}

/**
 * Conservative defaults. `minConfidence` is not yet calibrated against live Scribe log
 * probabilities (the `stt_confidence_wait` log carries each commit's value). Telephone speech
 * runs at about 2.5 words a second, so half a word a second over four seconds is noise.
 */
export const TRANSCRIPT_TRUST_DEFAULTS: Readonly<TranscriptTrustThresholds> = Object.freeze({
  minConfidence: 0.45,
  lowInformationMs: 4_000,
  minWordsPerSecond: 0.5,
  fragmentWords: 4,
});

/** Words that alone say nothing to doubt: a trailing "Okay, so..." is the caller thinking. */
const PLAIN = new Set(
  [
    ...CONFIRM_YES,
    ...CONFIRM_NO,
    ...['ok', 'okay', 'hmm', 'hm', 'um', 'uh', 'so', 'and', 'but', 'well', 'hello', 'hi'],
    ...['acha', 'achha', 'accha', 'matlab', 'woh', 'वो', 'मतलब', 'अच्छा'],
  ].flatMap((phrase) => normalizeForMatch(phrase).split(' ')),
);

/**
 * Whether a caller turn's words are doubtful, and why; undefined when they can be taken as heard.
 * The turn detector sets it on `turn.stopped` as `untrusted`: such a turn is still answered, but
 * nothing is done on its words (ending the call, a search, a decision); the agent asks again.
 */
export function transcriptDoubt(
  evidence: TranscriptEvidence,
  thresholds: Readonly<TranscriptTrustThresholds> = TRANSCRIPT_TRUST_DEFAULTS,
): TranscriptDoubt | undefined {
  const { text, language, confidence, spokenMs } = evidence;
  if (confidence !== undefined && confidence < thresholds.minConfidence) return 'low-confidence';
  const words = countWords(text, language);
  if (
    spokenMs !== undefined &&
    spokenMs >= thresholds.lowInformationMs &&
    (words * 1000) / spokenMs < thresholds.minWordsPerSecond
  )
    return 'low-information';
  if (
    /(\.\.\.|…)\s*$/u.test(text) &&
    words <= thresholds.fragmentWords &&
    normalizeForMatch(text)
      .split(' ')
      .some((word) => word && !PLAIN.has(word))
  )
    return 'fragment';
  return undefined;
}
