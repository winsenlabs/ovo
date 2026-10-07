const abbreviations: Record<string, readonly string[]> = {
  en: ['dr', 'mr', 'mrs', 'ms', 'rs', 'no', 'st', 'prof', 'sr', 'jr', 'vs', 'etc', 'approx'],
  hi: ['डॉ', 'डा', 'श्री', 'श्रीमती', 'रु'],
};

/** Clause marks that may end the first segment early (LAT-9). */
const CLAUSE = new Set([',', ';', ':', '—']);

/**
 * A sentence end and the closing quotes and brackets that belong to it, straight or curly (N7):
 * `trip?”` is one segment, never `trip?` and then a lone `”` the TTS would speak as a click. A
 * closer after a space (`trip? ”`, the French `oui »`) belongs to the sentence too.
 */
const CLOSERS = `["'”’»)\\]]`;
const TERMINAL = `[.!?।॥。！？؟۔]+${CLOSERS}*(?:\\s+[”»]+)?`;
const FIRST_SEGMENT = new RegExp(`${TERMINAL}|[,;:—]`, 'gu');
const LATER_SEGMENT = new RegExp(TERMINAL, 'gu');

/**
 * Where the next segment ends, or undefined to wait for more text. The first segment of a reply
 * may also end at a clause mark, so first audio does not wait for a whole sentence, but only once
 * it holds `minFirstWords` words: a lone "Okay," would be a 0.3 s clip followed by a gap while the
 * next segment renders.
 */
export function sentenceBoundary(
  text: string,
  maximum: number,
  language: string,
  flush: boolean,
  first: boolean,
  minFirstWords = 0,
): number | undefined {
  const expressions = first ? FIRST_SEGMENT : LATER_SEGMENT;
  const known = new Set([...abbreviations.en!, ...(abbreviations[language.split('-')[0]!] ?? [])]);
  for (const match of text.slice(0, maximum + 1).matchAll(expressions)) {
    const end = match.index + match[0].length;
    if (end > maximum) break;
    if (CLAUSE.has(match[0])) {
      // 1,000 and 10:30 are one token, also when the next digit has not streamed in yet.
      if (
        (match[0] === ',' || match[0] === ':') &&
        /\d/.test(text[match.index - 1] ?? '') &&
        (/\d/.test(text[end] ?? '') || (!flush && end === text.length))
      )
        continue;
      if (words(text.slice(0, match.index)) < minFirstWords) continue;
      return end;
    }
    const next = text.slice(end);
    // N7: the buffer ends at the mark inside an open quote, whose closer may be the next delta.
    // Only a flush cuts there; unquoted text still cuts at once, so first audio waits for nothing.
    if (!flush && !next.trim() && quoteOpen(text.slice(0, end))) return undefined;
    if (match[0].startsWith('.')) {
      if (next && !/^\s/.test(next)) continue;
      if (!flush && !next.trim()) continue;
      const word = /([\p{L}\p{M}]+)$/u.exec(text.slice(0, match.index))?.[1]?.toLowerCase();
      if (word && known.has(word)) continue;
    }
    return end;
  }
  return undefined;
}

/**
 * An opening quote or bracket in `text` that nothing has closed yet. ’ is left out of the count:
 * it is also the apostrophe of didn’t, so a curly single quote alone is never open.
 */
function quoteOpen(text: string): boolean {
  const count = (pattern: RegExp) => text.match(pattern)?.length ?? 0;
  return (
    count(/[“«(]/gu) > count(/[”»)]/gu) || count(/"/g) % 2 === 1 || count(/‘/gu) > count(/’/gu)
  );
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
