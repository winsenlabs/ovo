import { describe, expect, it } from 'vitest';
import { normalizeText, scriptShare, words } from '../src/text.ts';

describe('normalizeText', () => {
  it.each([
    ['lowercases and drops punctuation', 'Hello, World!!', 'hello world'],
    ['collapses spaces', '  credit   card \n please ', 'credit card please'],
    ['keeps digits', 'Plan #2, please', 'plan 2 please'],
    [
      'keeps Devanagari vowel signs and viramas, drops the danda',
      'मुझे क्रेडिट कार्ड चाहिए।',
      'मुझे क्रेडिट कार्ड चाहिए',
    ],
    ['keeps Tamil', 'எனக்கு கடன் வேண்டும்!', 'எனக்கு கடன் வேண்டும்'],
    ['drops zero-width joiners', 'क्‍ष', 'क्ष'],
    ['composes to NFC', 'café', 'café'],
    [
      'leaves Hinglish in Latin letters as words',
      'Mujhe naya CARD chahiye...',
      'mujhe naya card chahiye',
    ],
  ])('%s', (_name, input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });

  it('splits into words, and nothing for silence', () => {
    expect(words('Haan, loan chahiye')).toEqual(['haan', 'loan', 'chahiye']);
    expect(words(' ... ')).toEqual([]);
  });
});

describe('scriptShare', () => {
  it.each([
    ['English', 'I need a new card', ['en'], 1],
    ['Hindi in Devanagari', 'मुझे नया कार्ड चाहिए', ['hi'], 1],
    ['Marathi shares Devanagari', 'मला नवीन कार्ड हवे आहे', ['mr'], 1],
    ['Hinglish in Latin letters is not Devanagari', 'mujhe naya card chahiye', ['hi'], 0],
    ['Hinglish in Latin letters is Latin', 'mujhe naya card chahiye', ['en'], 1],
    ['Tamil', 'எனக்கு கடன் வேண்டும்', ['ta'], 1],
    ['Telugu', 'నాకు రుణం కావాలి', ['te'], 1],
    ['Kannada', 'ನನಗೆ ಸಾಲ ಬೇಕು', ['kn'], 1],
    ['Malayalam', 'എനിക്ക് വായ്പ വേണം', ['ml'], 1],
    ['Bengali', 'আমার ঋণ দরকার', ['bn'], 1],
    ['Gujarati', 'મને લોન જોઈએ છે', ['gu'], 1],
    ['Punjabi in Gurmukhi', 'ਮੈਨੂੰ ਕਰਜ਼ਾ ਚਾਹੀਦਾ ਹੈ', ['pa'], 1],
    ['Urdu in the Arabic script', 'مجھے قرض چاہیے', ['ur'], 1],
    ['Tamil is not Hindi', 'எனக்கு கடன் வேண்டும்', ['hi', 'mr'], 0],
    ['an unknown language has no script', 'hello', ['xx'], 0],
    ['no letters at all', '1234 ...', ['en'], 0],
  ])('%s', (_name, text, languages, share) => {
    expect(scriptShare(text, languages)).toBeCloseTo(share, 5);
  });

  it('measures a mixed reply by letters, ignoring digits and punctuation', () => {
    // "card" (4 Latin letters) inside Devanagari: the Devanagari share is below 1 but above half.
    const share = scriptShare('मुझे नया card चाहिए 2!', ['hi']);
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(1);
    expect(scriptShare('मुझे नया card चाहिए 2!', ['hi', 'en'])).toBe(1);
  });
});
