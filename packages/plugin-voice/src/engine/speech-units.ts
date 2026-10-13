/**
 * Wave 9 D1: a reply line the segmenter ended inside a date, an amount or a range, which the
 * caller must hear as one: "a budget of seventy thousand rupees—" then "one lakh rupees per
 * person" (the first segment may end at an em dash), "…from December 21 –" then "January 5…", or
 * a sentence over the segment length cut after "December". The engine joins such a line to the
 * next before it is spoken, so the speech normaliser sees the whole range and the TTS
 * renders it in one breath. A clause dash after words ("Sorry, I didn’t catch that—") is a pause,
 * not a split: it is spoken at once.
 */
const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
/** The words a spoken amount ends on; "one—" or "days—" is as often a clause as a range. */
const AMOUNT_WORDS =
  'hundred|thousand|lakh|lakhs|crore|crores|million|billion|rupees|rupee|dollars|euros|pounds|percent';
const DASH_AFTER_AMOUNT = new RegExp(
  String.raw`(?:\d[\d,.]*(?:st|nd|rd|th|k|K|%)?|\b(?:${AMOUNT_WORDS}))\s*[–—-]$`,
  'iu',
);
/**
 * A line this long ended without a sentence end only because the segmenter's length cap (240
 * characters) cut it at a space: a first segment is cut at 60. Cut after a month, a day or a
 * number ("…on December" then "21, 2026–January 5…"), it waits for the rest. A shorter line ending
 * on a month ("…markets in December" then "and January…") is a phrase cut and is said at once.
 */
const CAP_CUT_CHARS = 120;
// Wave 10 (B4): or before the second day of a choice ("…on December 20 or" then "21, 2026").
const OPEN_DATE = new RegExp(
  String.raw`(?:\b(?:${MONTHS})|\d(?:st|nd|rd|th)?,?)(?:\s+(?:or|and))?$`,
  'u',
);

export function splitsSpeechUnit(line: string): boolean {
  const text = line.trimEnd();
  return DASH_AFTER_AMOUNT.test(text) || (text.length >= CAP_CUT_CHARS && OPEN_DATE.test(text));
}
