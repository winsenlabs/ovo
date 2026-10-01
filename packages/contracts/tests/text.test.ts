import { describe, expect, it } from 'vitest';
import {
  CONFIRM_FILLERS,
  CONFIRM_NO,
  CONFIRM_YES,
  classifyConfirmation,
  countWords,
  normalizeForMatch,
} from '../src/index.ts';

describe('normalizeForMatch', () => {
  it('keeps Devanagari combining marks (#18)', () => {
    expect(normalizeForMatch('हाँ!')).toBe('हाँ');
    expect(normalizeForMatch('  नहीं, रुको।  ')).toBe('नहीं रुको');
    expect(normalizeForMatch('ठीक है?')).toBe('ठीक है');
    // The vowel sign, candrabindu and anusvara are \p{M}; stripping them would change the word.
    expect([...normalizeForMatch('हाँ')].length).toBe(3);
  });

  it('applies NFKC, lower case, collapses separators and trims', () => {
    expect(normalizeForMatch('ＹＥＳ，Please')).toBe('yes please');
    expect(normalizeForMatch("Don't — STOP!!")).toBe('don t stop');
    expect(normalizeForMatch('...')).toBe('');
  });
});

describe('countWords', () => {
  it('counts word-like segments only', () => {
    expect(countWords('Yes, please!', 'en')).toBe(2);
    expect(countWords('हाँ जी, ठीक है', 'hi')).toBe(4);
    expect(countWords('   ', 'en')).toBe(0);
    expect(countWords('one two', 'not a locale!')).toBe(2);
  });
});

describe('confirmation lexicons', () => {
  it('are stored pre-normalized, exactly as §2.10 lists them', () => {
    for (const phrase of [...CONFIRM_YES, ...CONFIRM_NO, ...CONFIRM_FILLERS])
      expect(normalizeForMatch(phrase)).toBe(phrase);
    expect(CONFIRM_YES).toEqual(
      expect.arrayContaining(['yes', 'haan', 'aama', 'avunu', 'haudu', 'hoy', 'hya']),
    );
    expect(CONFIRM_NO).toEqual(
      expect.arrayContaining(['no', 'nahi', 'illa', 'kaadu', 'beda', 'nako', 'না']),
    );
    expect(CONFIRM_FILLERS).toEqual([
      'please',
      'ok',
      'okay',
      'ji',
      'sir',
      'madam',
      'hmm',
      'uh',
      'um',
    ]);
    expect(Object.isFrozen(CONFIRM_YES)).toBe(true);
  });
});

describe('classifyConfirmation (#10)', () => {
  it.each([
    ['Yes!', 'yes'],
    ['yes please', 'yes'],
    ['okay yes', 'yes'],
    ['haan ji', 'yes'],
    ['ji haan', 'yes'],
    ['Go ahead, sir.', 'yes'],
    ['हाँ!', 'yes'],
    ['हां', 'yes'],
    ['हां जी', 'unclear'],
    ['ठीक है', 'yes'],
    ['okay', 'unclear'],
    ['', 'unclear'],
    ['please', 'unclear'],
    ["no that's not correct", 'no'],
    ['no that is not correct', 'no'],
    ['yes… no, cancel', 'no'],
    ["don't do it", 'no'],
    ['hold on a second', 'no'],
    ['नहीं', 'no'],
    ['haan... ruko', 'no'],
    ['yes and also book another', 'unclear'],
    ['yes yes', 'unclear'],
    ['on hold', 'unclear'],
    ['ஆமாம்', 'yes'],
    ['aama yes', 'yes'],
    ['இல்லை', 'no'],
    ['అవును', 'yes'],
    ['avunu yes', 'yes'],
    ['కాదు', 'no'],
    ['ಹೌದು', 'yes'],
    ['haudu yes', 'yes'],
    ['ಬೇಡ', 'no'],
    ['होय', 'yes'],
    ['hoy yes', 'yes'],
    ['नको', 'no'],
    ['হ্যাঁ', 'yes'],
    ['hya yes', 'yes'],
    ['না', 'no'],
    ['avunu book another', 'unclear'],
    ['xavunuy', 'unclear'],
  ] as const)('%j → %s', (input, expected) => {
    expect(classifyConfirmation(input)).toBe(expected);
  });
});
