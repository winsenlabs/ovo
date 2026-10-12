/*
 * Wave 8b (Maya call e8a43f65): words that carry on the caller's previous utterance rather than
 * start a new one. Scribe split "…to the 5th." from "Of January.", and "…Zagreb, Prague." from
 * "Germany, Berlin, and a few other places.": the second half begins with a preposition, a month,
 * a lower-case word or the next item of a list. Read without a model, so the turn detector and the
 * engine agree on it.
 */

const words = (list: string) => new Set(list.split(' '));

/** First words that only continue a sentence: prepositions, conjunctions and month names. */
const CONTINUING = words(
  'of in on at to from till until through by for with and or but nor plus than ' +
    'january february march april june july august september october november december',
);
/** First words of a new sentence, even before a comma ("Yes, …", "Okay, …"): never a list item. */
const OPENERS = words(
  'yes yeah yep no nope ok okay so well hey hi hello sorry please thanks actually also then ' +
    'wait um uh hmm oh right sure alright listen look',
);
/** Asides between commas that name nothing: a yes, a no, a word of address. */
const ASIDES = words(
  'yes yeah yep ok okay no nope sir madam maam ji please thanks right sure well so um uh hmm',
);
/** The next list item: one to three capitalised words and a comma ("Germany, Berlin, …"). */
const LIST_ITEM = /^(\p{Lu}[\p{L}\p{M}'’-]*)(?:\s+\p{Lu}[\p{L}\p{M}'’-]*){0,2},/u;
/** A list or clause still going at the end of the earlier words: "Budapest, Vienna,". */
const TRAILING_COMMA = /[,;:،、]["'”’)\]]*\s*$/u;

/**
 * True when `later` carries on `earlier` instead of saying something new: it starts with a word
 * no sentence starts with ("Of January.", "and Rome"), with a lower-case word after an STT that
 * capitalises its sentences ("in Austria."), or with the next item of a list `earlier` was giving
 * ("…Zagreb, Prague." + "Germany, Berlin, and…"); or `earlier` ended mid-list on a comma.
 */
export function continuesUtterance(later: string, earlier = ''): boolean {
  const text = later.trim().replace(/^["'“‘(\[]+/u, '');
  const before = earlier.trim();
  const first = /^[\p{L}\p{M}'’]+/u.exec(text)?.[0];
  if (!first) return false;
  if (before && TRAILING_COMMA.test(before)) return true;
  if (CONTINUING.has(first.toLowerCase().replace(/['’]/gu, ''))) return true;
  // Only an STT that capitalises a sentence's first word says anything by a lower-case one.
  if (/^\p{Ll}/u.test(first) && /^["'“‘(\[]*\p{Lu}/u.test(before)) return true;
  const item = LIST_ITEM.exec(text);
  return Boolean(item && !OPENERS.has(item[1]!.toLowerCase()) && /,/u.test(lastSentence(before)));
}

/**
 * True when some sentence of `text` is a list of three or more short items, separated by commas
 * and "and"/"or", at least one a comma: "Germany, Berlin, and a few other places.", "Rome, Paris,
 * Vienna". Places, dates or people the caller is naming, not a request.
 */
export function listsItems(text: string): boolean {
  return sentences(text).some((sentence) => {
    if (!sentence.includes(',')) return false;
    const items = sentence
      .split(/,|\band\b|\bor\b/u)
      .map((item) => item.trim())
      .filter(Boolean);
    // "Two checks, sir, yes." is an answer with a word of address, not three things named.
    const named = items.filter((item) => !ASIDES.has(item.toLowerCase().replace(/['’]/gu, '')));
    return named.length >= 3 && items.every((item) => item.split(/\s+/u).length <= 4);
  });
}

/** The sentences of `text`, split at closing punctuation. */
export function sentences(text: string): string[] {
  return text
    .split(/[.?!।॥？！。…]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function lastSentence(text: string): string {
  return sentences(text).at(-1) ?? '';
}
