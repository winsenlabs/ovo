const abbreviations: Record<string, readonly string[]> = {
  en: ['dr', 'mr', 'mrs', 'ms', 'rs', 'no', 'st', 'prof', 'sr', 'jr', 'vs', 'etc', 'approx'],
  hi: ['डॉ', 'डा', 'श्री', 'श्रीमती', 'रु'],
};

/** Clause marks that may end the first segment early (LAT-9). */
const CLAUSE = new Set([',', ';', ':', '—']);

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
  const expressions = first ? /[.!?।॥。！？؟۔]+["')\]]*|[,;:—]/gu : /[.!?।॥。！？؟۔]+["')\]]*/gu;
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
    if (match[0].startsWith('.')) {
      const next = text.slice(end);
      if (next && !/^\s/.test(next)) continue;
      if (!flush && !next.trim()) continue;
      const word = /([\p{L}\p{M}]+)$/u.exec(text.slice(0, match.index))?.[1]?.toLowerCase();
      if (word && known.has(word)) continue;
    }
    return end;
  }
  return undefined;
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}
