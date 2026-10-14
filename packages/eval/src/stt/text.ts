// Word and character error rates for Indian English and Hinglish, where the same Hindi word may be
// written in Devanagari or in any of several romanisations.

/**
 * Hesitations, which transcribers and STTs write or drop at will; they are not scored. An
 * acknowledgement ("mm-hmm", "uh-huh") is a word, folded to one spelling first.
 */
const FILLERS = new Set(['uh', 'uhh', 'um', 'umm', 'er', 'erm', 'hmm', 'hm', 'mm', 'mmm', 'अ']);

/**
 * Words as a transcriber compares them: NFKC, lower case, no punctuation (Latin or the Devanagari
 * danda), digit groups joined ("4,210" is one word), chandrabindu folded into anusvara and the
 * nukta dropped (STTs disagree on both), hesitations dropped, whitespace collapsed.
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ँ/g, 'ं')
    .replace(/़/g, '')
    .replace(/\b(?:m+-?hm+|uh-?huh)\b/g, 'mhm')
    .replace(/(\d)[,.](?=\d)/g, '$1')
    .replace(/['’](?=\p{L})/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !FILLERS.has(word));
}

/** Levenshtein distance between two token sequences. */
export function editDistance<T>(reference: readonly T[], hypothesis: readonly T[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (reference[i - 1] === hypothesis[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[hypothesis.length]!;
}

const VOWELS: Readonly<Record<string, string>> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ee',
  उ: 'u',
  ऊ: 'oo',
  ऋ: 'ri',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
  ऑ: 'o',
};
const MATRAS: Readonly<Record<string, string>> = {
  'ा': 'aa',
  'ि': 'i',
  'ी': 'ee',
  'ु': 'u',
  'ू': 'oo',
  'ृ': 'ri',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
  'ॉ': 'o',
};
const CONSONANTS: Readonly<Record<string, string>> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'n',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'n',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
};
const VIRAMA = '्';

/**
 * A plain romanisation of Devanagari, the way Hinglish is typed ("मेरा नाम" → "mera naam"): each
 * consonant carries an inherent "a" unless a vowel sign or virama follows, and a word's final
 * inherent "a" is dropped (schwa deletion). Lossy by design: it only has to bring both scripts
 * close enough for `phoneticKey` to match them. Other characters pass through.
 */
export function romanizeDevanagari(text: string): string {
  return text.replace(/[ऀ-ॿ]+/g, (word) => {
    let out = '';
    const chars = [...word];
    for (let i = 0; i < chars.length; i += 1) {
      const char = chars[i]!;
      const next = chars[i + 1];
      if (CONSONANTS[char] !== undefined) {
        out += CONSONANTS[char];
        if (next === undefined) continue;
        if (next === VIRAMA) i += 1;
        else if (MATRAS[next] === undefined) out += 'a';
      } else if (MATRAS[char] !== undefined) out += MATRAS[char];
      else if (VOWELS[char] !== undefined) out += VOWELS[char];
      else if (char === 'ं' || char === 'ँ') out += 'n';
      else if (char === 'ः') out += 'h';
    }
    return out;
  });
}

/**
 * A word's sound, spelled loosely: romanised, letters only, aspiration and vowel length dropped,
 * doubled letters collapsed, and the common Hinglish spelling swaps (w/v, z/j, ph/f, ee/i, oo/u)
 * folded. "haan", "han" and "हाँ" share a key; so do "accha", "acha" and "अच्छा".
 */
export function phoneticKey(word: string): string {
  return romanizeDevanagari(word.normalize('NFKC').toLowerCase())
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/ee/g, 'i')
    .replace(/oo/g, 'u')
    .replace(/([bcdgjkpt])h+/g, '$1')
    .replace(/(.)\1+/g, '$1')
    .replace(/(?<=.)[aeiou]+$/g, (vowel) => vowel[0]!)
    .replace(/y$/g, 'i');
}

export interface ErrorCount {
  errors: number;
  /** Reference length: words for WER, characters for CER. */
  length: number;
  /** The reference that matched best. */
  reference: string;
}

function rate(count: ErrorCount): number {
  return count.length ? count.errors / count.length : count.errors ? 1 : 0;
}

function best(
  references: readonly string[],
  hypothesis: string,
  tokens: (text: string) => string[],
): ErrorCount {
  const said = tokens(hypothesis);
  let found: ErrorCount | undefined;
  for (const reference of references) {
    const words = tokens(reference);
    const count = { errors: editDistance(words, said), length: words.length, reference };
    if (!found || rate(count) < rate(found)) found = count;
  }
  return found ?? { errors: said.length, length: 0, reference: '' };
}

/** Word errors against the closest accepted reference (Devanagari, romanised or English). */
export function wordErrors(references: readonly string[], hypothesis: string): ErrorCount {
  return best(references, hypothesis, normalizeWords);
}

/**
 * Word errors after both sides are reduced to `phoneticKey`s: script and spelling no longer
 * count, so "mera naam" against "मेरा नाम" is right. The figure to read for Hinglish.
 */
export function looseWordErrors(references: readonly string[], hypothesis: string): ErrorCount {
  return best(references, hypothesis, (text) =>
    normalizeWords(text)
      .map(phoneticKey)
      .filter((key) => key),
  );
}

/** Character errors on the normalised words joined by single spaces. */
export function characterErrors(references: readonly string[], hypothesis: string): ErrorCount {
  return best(references, hypothesis, (text) => [...normalizeWords(text).join(' ')]);
}
