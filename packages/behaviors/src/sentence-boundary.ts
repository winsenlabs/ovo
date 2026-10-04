const abbreviations: Record<string, readonly string[]> = {
  en: ['dr', 'mr', 'mrs', 'ms', 'rs', 'no', 'st', 'prof', 'sr', 'jr', 'vs', 'etc', 'approx'],
  hi: ['डॉ', 'डा', 'श्री', 'श्रीमती', 'रु'],
};

export function sentenceBoundary(
  text: string,
  maximum: number,
  language: string,
  flush: boolean,
  first: boolean,
): number | undefined {
  const expressions = first ? /[.!?।॥。！？؟۔]+["')\]]*|,/gu : /[.!?।॥。！？؟۔]+["')\]]*/gu;
  const known = new Set([...abbreviations.en!, ...(abbreviations[language.split('-')[0]!] ?? [])]);
  for (const match of text.slice(0, maximum + 1).matchAll(expressions)) {
    const end = match.index + match[0].length;
    if (end > maximum) break;
    if (match[0] === ',') {
      if (
        /\d/.test(text[match.index - 1] ?? '') &&
        (/\d/.test(text[end] ?? '') || (!flush && end === text.length))
      )
        continue;
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
