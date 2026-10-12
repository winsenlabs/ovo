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

/** The sounds callers think aloud with, as STTs write them ("umm", "uh", "अम्म"). */
const HESITATIONS = words('um umm ummm uh uhh uhm er erm अम्म उम्म');
/** Words no sentence ends on, whatever the STT put after them: articles and possessives. */
const DETERMINERS = words('a an the my your our their');
/** Words a sentence goes on after: prepositions and conjunctions ("fly out on", "but"). */
const LEADING_ON = words(
  'to of for in on at with from about into onto than and but or nor because',
);
/** The last word of `text`, before any punctuation (none when the text ends on a number). */
const LAST_WORD = /([\p{L}\p{M}'’]+)[^\p{L}\p{M}\p{N}]*$/u;
const CLOSED = /[.?!।॥？！。]["'”’)\]]*\s*$/u;
/** The STT's own mark of words breaking off: a trailing "...", "…" or dash. */
const BROKEN_OFF = /(?:[-–—]|…|\.\.\.)["'”’)\]]*\s*$/u;

/**
 * Wave 9 (Maya call 10d5ef30, issue D3): the caller stopped mid-thought rather than at the end of
 * what they meant to say: the words end on a hesitation ("No, umm..."), an article or possessive
 * ("it should still be a"), or a preposition or conjunction the STT did not close with a full stop
 * or question mark ("…tell me what places are nice in-", "I expect to fly out on..."; not "Where
 * are you from?"). A capital "A" closing a sentence names something ("Plan A.").
 */
export function pausesMidThought(text: string): boolean {
  const trimmed = text.trim();
  const raw = LAST_WORD.exec(trimmed)?.[1];
  if (!raw) return false;
  const last = raw.toLowerCase().replace(/['’]/gu, '');
  if (HESITATIONS.has(last)) return true;
  const open = !CLOSED.test(trimmed) || BROKEN_OFF.test(trimmed);
  if (DETERMINERS.has(last)) return raw !== 'A' || open;
  return LEADING_ON.has(last) && open;
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
