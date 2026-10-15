import { describe, expect, it } from 'vitest';
import { baseLanguage, misdetections, scriptsOf } from '../language.ts';
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
