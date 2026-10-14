import { describe, expect, it } from 'vitest';
import { baseLanguage, misdetections, scriptsOf } from '../language.ts';
import {
  characterErrors,
  looseWordErrors,
  normalizeWords,
  phoneticKey,
  romanizeDevanagari,
  wordErrors,
} from '../text.ts';

describe('Hinglish-aware error rates', () => {
  it('normalises words as a transcriber compares them', () => {
    expect(normalizeWords("Hey, Maya. What's your REAL name?")).toEqual([
      'hey',
      'maya',
      'whats',
      'your',
      'real',
      'name',
    ]);
    expect(normalizeWords('₹4,210 — हाँ, मैं।')).toEqual(['4210', 'हां', 'मैं']);
    // Nukta and chandrabindu spellings of one word compare equal.
    expect(normalizeWords('ज़रूर हाँ')).toEqual(normalizeWords('जरूर हां'));
  });

  it('romanises Devanagari the way Hinglish is typed', () => {
    expect(romanizeDevanagari('मेरा नाम क्या है')).toBe('meraa naam kyaa hai');
    expect(romanizeDevanagari('अच्छा')).toBe('achchhaa');
    expect(romanizeDevanagari('Tejas तेजस')).toBe('Tejas tejas');
  });

  it('gives one spelling key to the scripts and romanisations of a word', () => {
    expect(phoneticKey('haan')).toBe(phoneticKey('हाँ'));
    expect(phoneticKey('han')).toBe(phoneticKey('haan'));
    expect(phoneticKey('accha')).toBe(phoneticKey('अच्छा'));
    expect(phoneticKey('acha')).toBe(phoneticKey('accha'));
    expect(phoneticKey('naam')).toBe(phoneticKey('नाम'));
    expect(phoneticKey('Tejas')).not.toBe(phoneticKey('Taj'));
  });

  it('scores against the closest accepted reference', () => {
    const references = ['मेरा नाम है तेजस', 'mera naam hai Tejas'];
    expect(wordErrors(references, 'mera naam hai Tejas')).toMatchObject({ errors: 0, length: 4 });
    expect(wordErrors(references, 'मेरा नाम है तेज इजाफा')).toMatchObject({ errors: 2, length: 4 });
    // Strictly, mixed script is wrong; loosely only the misheard name is.
    expect(wordErrors(references, 'मेरा naam है Tejas').errors).toBe(2);
    expect(looseWordErrors(references, 'मेरा naam है Tejas').errors).toBe(0);
    expect(looseWordErrors(references, 'मेरा नाम है तेज इजाफा').errors).toBe(2);
  });

  it('counts character errors on the normalised text', () => {
    expect(characterErrors(['Zagreb'], 'zagreb.')).toMatchObject({ errors: 0, length: 6 });
    expect(characterErrors(['Brandenburg'], 'Brandon')).toMatchObject({ errors: 5, length: 11 });
  });

  it('charges every word of a transcript of nothing as an error, and nothing as nothing', () => {
    expect(wordErrors([''], 'hello there')).toMatchObject({ errors: 2, length: 0 });
    expect(wordErrors(['hello there'], '')).toMatchObject({ errors: 2, length: 2 });
  });
});

describe('language misdetection', () => {
  it("flags call 8's drift into German and Turkish and call 7's into Spanish and Tamil", () => {
    expect(misdetections('Ah, aber, äh, war noch nicht.')).toEqual([
      'letter ä',
      'words aber, noch, nicht',
    ]);
    expect(misdetections('Hıhı.')).toEqual(['letter ı']);
    expect(misdetections('No. I- Bueno, buenas tardes.')).toEqual(['words bueno, buenas, tardes']);
    expect(misdetections('நான் கார்த்தி.')).toEqual(['tamil script']);
  });

  it('leaves English and romanised or Devanagari Hindi alone when the caller spoke them', () => {
    expect(misdetections("Hey Maya, what's your real name?")).toEqual([]);
    expect(misdetections('haan ji, mera naam Tejas hai')).toEqual([]);
    expect(misdetections('मेरा नाम है तेजस', ['hi', 'en'])).toEqual([]);
    expect(misdetections('நான் கார்த்தி.', ['ta'])).toEqual([]);
  });

  it('flags Devanagari for an English-only utterance and a reported foreign language', () => {
    expect(misdetections('तेज इजाफा', ['en'])).toEqual(['devanagari script']);
    expect(misdetections('', ['en', 'hi'], 'deu')).toEqual(['provider reported deu']);
    expect(misdetections('', ['en', 'hi'], 'eng')).toEqual([]);
    expect(misdetections('', ['en', 'hi'], 'hin')).toEqual([]);
    expect(baseLanguage('en-IN')).toBe('en');
    expect(scriptsOf('Hi मेरा')).toEqual(['devanagari', 'latin']);
  });
});
