// Hinglish-aware comparison text. A caller's Hindi may come back from the STT in Devanagari
// ("हाँ ठीक है") or romanised ("haan theek hai"), and a gold file may hold either. Both sides are
// transliterated to Latin and folded phonetically, so the same words match whichever script they
// were written in. Approximate on purpose: it is for scoring, never for display.

const CONSONANTS: Record<string, string> = {
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
  ळ: 'l',
};
/** A consonant with a nukta (़): the Urdu and English sounds. */
const NUKTA: Record<string, string> = {
  क: 'q',
  ख: 'kh',
  ग: 'g',
  ज: 'z',
  ड: 'r',
  ढ: 'rh',
  फ: 'f',
  य: 'y',
};
const VOWELS: Record<string, string> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ii',
  उ: 'u',
  ऊ: 'uu',
  ऋ: 'ri',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
  ऍ: 'e',
  ऑ: 'o',
};
const SIGNS: Record<string, string> = {
  'ा': 'aa',
  'ि': 'i',
  'ी': 'ii',
  'ु': 'u',
  'ू': 'uu',
  'ृ': 'ri',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
  'ॅ': 'e',
  'ॉ': 'o',
};
const NASAL: Record<string, string> = { 'ं': 'n', 'ँ': 'n', 'ः': 'h' };
const VIRAMA = '्';
const NUKTA_SIGN = '़';
const DIGIT_ZERO = 0x0966;

/** Devanagari to Latin, with the word-final inherent "a" dropped as Hindi speech drops it. */
export function romanise(text: string): string {
  const chars = [...text.normalize('NFD')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    const code = char.codePointAt(0)!;
    if (code >= DIGIT_ZERO && code <= DIGIT_ZERO + 9) {
      out += String(code - DIGIT_ZERO);
      continue;
    }
    if (char === '।' || char === '॥') {
      out += '.';
      continue;
    }
    if (VOWELS[char] !== undefined) {
      out += VOWELS[char];
      continue;
    }
    if (SIGNS[char] !== undefined || NASAL[char] !== undefined) {
      out += SIGNS[char] ?? NASAL[char];
      continue;
    }
    const consonant = CONSONANTS[char];
    if (consonant === undefined) {
      if (char !== VIRAMA && char !== NUKTA_SIGN) out += char;
      continue;
    }
    let next = chars[i + 1];
    let sound = consonant;
    if (next === NUKTA_SIGN) {
      sound = NUKTA[char] ?? consonant;
      next = chars[++i + 1];
    }
    out += sound;
    if (next === VIRAMA) {
      i++;
      continue;
    }
    // The inherent vowel, unless a vowel sign follows or the word ends here.
    const ends = next === undefined || !isDevanagari(next) || next === '।';
    if (next !== undefined && SIGNS[next] !== undefined) continue;
    if (!ends) out += 'a';
  }
  return out;
}

export function isDevanagari(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x0900 && code <= 0x097f;
}

/**
 * Lower-case Latin with spelling differences folded away: long vowels, aspirates, doubled
 * letters and diacritics ("theek" = "thik" = "ठीक", "accha" = "acha" = "अच्छा").
 */
export function fold(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ee|ii/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/chh/g, 'ch')
    .replace(/(?:c?ch)+/g, 'ch')
    .replace(/([kgjtdpb])h/g, '$1')
    .replace(/sh/g, 's')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/q/g, 'k')
    .replace(/ph|f/g, 'p')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Words for scoring: NFKC, Devanagari romanised, digit groups joined ("4,210" is one word),
 * punctuation (Latin and the danda) dropped, each word folded.
 */
export function scoringWords(text: string): string[] {
  return romanise(text.normalize('NFKC'))
    .toLowerCase()
    .replace(/(\d)[,.](?=\d)/g, '$1')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(fold)
    .filter(Boolean);
}
