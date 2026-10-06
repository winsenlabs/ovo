/**
 * Expands a POC whole-utterance rule regex into the finite list of phrases it matches. Flow rules
 * are phrase lists, never user regexes (no ReDoS, and an operator can read them), so the importer
 * accepts only the regex subset the POC actually uses: `^…$` anchors, literal characters, groups,
 * alternation and the `?` quantifier. Anything else is refused rather than approximated.
 */

const MAX_PHRASES = 5_000;
const UNSUPPORTED = new Set(['[', ']', '*', '+', '{', '}', '.', '^', '$']);

export class RegexPhrasesError extends Error {
  constructor(source: string, reason: string) {
    super(`Cannot expand /${source}/ into phrases: ${reason}`);
    this.name = 'RegexPhrasesError';
  }
}

export function regexPhrases(pattern: RegExp): string[] {
  const source = pattern.source;
  if (!source.startsWith('^') || !source.endsWith('$') || source.endsWith('\\$'))
    throw new RegexPhrasesError(source, 'a rule must match the whole utterance (^…$)');
  const chars = [...source.slice(1, -1)];
  let at = 0;
  const fail = (reason: string): never => {
    throw new RegexPhrasesError(source, `${reason} at character ${at + 1}`);
  };
  const bounded = (phrases: string[]) =>
    phrases.length > MAX_PHRASES ? fail(`more than ${MAX_PHRASES} phrases`) : phrases;

  const alternation = (): string[] => {
    const options = [...sequence()];
    while (chars[at] === '|') {
      at += 1;
      options.push(...sequence());
    }
    return bounded([...new Set(options)]);
  };
  const sequence = (): string[] => {
    let phrases = [''];
    while (at < chars.length && chars[at] !== '|' && chars[at] !== ')') {
      let atom = term();
      if (chars[at] === '?') {
        at += 1;
        atom = ['', ...atom];
      }
      phrases = bounded(phrases.flatMap((head) => atom.map((tail) => head + tail)));
    }
    return phrases;
  };
  const term = (): string[] => {
    const char = chars[at]!;
    if (char === '(') {
      at += 1;
      if (chars[at] === '?') {
        if (chars[at + 1] !== ':') fail('only (?: …) groups are supported');
        at += 2;
      }
      const inner = alternation();
      if (chars[at] !== ')') fail('unclosed group');
      at += 1;
      return inner;
    }
    if (char === '\\') {
      const escaped = chars[at + 1];
      if (escaped === undefined || /[\p{L}\p{N}]/u.test(escaped)) fail('character classes');
      at += 2;
      return [escaped!];
    }
    if (char === '?') fail('a quantifier with nothing to repeat');
    if (UNSUPPORTED.has(char)) fail(`unsupported construct ${char}`);
    at += 1;
    return [char];
  };

  // `^a|b$` means "starts with a, or ends with b", not a whole utterance: it needs `^(a|b)$`.
  const phrases = sequence();
  if (chars[at] === '|') fail('a top-level | (write ^(a|b)$)');
  if (at !== chars.length) fail('unbalanced )');
  return pattern.flags.includes('i') ? [...new Set(phrases.map((p) => p.toLowerCase()))] : phrases;
}
