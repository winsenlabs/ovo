import { describe, expect, it } from 'vitest';
import { parseGold } from '../src/corpus/gold.ts';
import { fold, romanise, scoringWords } from '../src/score/hinglish.ts';
import { foreignTranscript, mismatchesGold, scriptOf } from '../src/score/language.ts';
import { segmentTexts, sttScore } from '../src/score/stt.ts';
import { charErrors, editDistance, wordErrors } from '../src/score/wer.ts';

describe('Hinglish folding', () => {
  it('romanises Devanagari with the word-final schwa dropped', () => {
    expect(romanise('ठीक है')).toBe('thiik hai');
    expect(romanise('हाँ')).toBe('haan');
    expect(romanise('अच्छा')).toBe('achchhaa');
    expect(romanise('नहीं')).toBe('nahiin');
    expect(romanise('ज़रूर')).toBe('zaruur');
    expect(romanise('२०२६।')).toBe('2026.');
  });

  it('folds spelling differences so either script matches', () => {
    expect(scoringWords('हाँ, ठीक है।')).toEqual(scoringWords('haan theek hai'));
    expect(scoringWords('अच्छा')).toEqual(scoringWords('accha'));
    expect(fold('Zaroor')).toBe(fold('jarur'));
    expect(scoringWords('4,210 rupees')).toEqual(['4210', 'rupis']);
  });
});

describe('WER and CER', () => {
  it('counts edits against the closest accepted reference', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2);
    expect(wordErrors(['haan theek hai', 'हाँ ठीक है'], 'हाँ, ठीक है।')).toEqual({
      errors: 0,
      length: 3,
    });
    expect(wordErrors(['my name is Tejas'], 'मेरा नाम है तेज इजाफा')).toMatchObject({ length: 4 });
    expect(charErrors(['Tejas'], 'tejas')).toEqual({ errors: 0, length: 5 });
  });
});

describe('language misdetection', () => {
  it.each([
    ['Ah, aber, äh, war noch nicht.', 'letters'],
    ['Hıhı.', 'letters'],
    ['Çok.', 'letters'],
    ['No. I- Bueno, buenas tardes.', 'words'],
    ['aber nicht so', 'words'],
    ['Да, конечно', 'script'],
  ])('%s is a language the caller was not speaking (%s)', (text, why) => {
    expect(foreignTranscript(text)).toEqual({ foreign: true, why });
  });

  it.each([
    'Yeah, for both these places.',
    'हाँ, ठीक है।',
    'Haan ji, tamam ho gaya',
    'Ja raha hoon',
  ])('%s is English or Hinglish', (text) => expect(foreignTranscript(text).foreign).toBe(false));

  it('flags English heard as Devanagari against gold, and Devanagari without Hindi', () => {
    expect(scriptOf('मेरा नाम है तेज इजाफा')).toBe('devanagari');
    expect(mismatchesGold('तेज इजाफा', 'en')).toBe(true);
    expect(mismatchesGold('तेज इजाफा', 'mixed')).toBe(false);
    expect(foreignTranscript('नमस्ते', ['en'])).toEqual({ foreign: true, why: 'script' });
  });
});

describe('STT against gold', () => {
  const gold = parseGold({
    utterances: [
      { id: 'u1', startMs: 1000, endMs: 3000, text: 'my name is Tejas', language: 'en' },
      {
        id: 'u2',
        startMs: 5000,
        endMs: 6000,
        text: 'haan theek hai',
        devanagari: 'हाँ ठीक है',
        language: 'hi',
      },
    ],
  });
  const transcript = (atMs: number, segmentId: string, text: string, final = true) => ({
    atMs,
    segmentId,
    text,
    final,
  });

  it('takes each segment final, or its last interim when it never finalised', () => {
    expect(
      segmentTexts([
        transcript(100, '0', 'my', false),
        transcript(200, '0', 'my name', true),
        transcript(300, '1', 'is', false),
      ]).map((s) => [s.text, s.final]),
    ).toEqual([
      ['my name', true],
      ['is', false],
    ]);
  });

  it('scores the call in order, Devanagari matching the romanised gold', () => {
    const score = sttScore(
      [transcript(3300, '0', 'My name is तेज इजाफा.'), transcript(6400, '1', 'हाँ, ठीक है।')],
      gold,
      ['en', 'hi'],
    );
    // "tejas" heard as two Devanagari words: one substitution, one insertion.
    expect(score.words).toBe(7);
    expect(score.edits).toBe(2);
    expect(score.wer).toBeCloseTo(2 / 7);
    expect(score.rows.map((row) => [row.id, row.heard, row.languageMismatch])).toEqual([
      ['u1', 'My name is तेज इजाफा.', false],
      ['u2', 'हाँ, ठीक है।', false],
    ]);
    expect(score.languageMismatches).toBe(0);
  });

  it('counts foreign transcripts without gold, and needs gold for WER', () => {
    const score = sttScore([transcript(1000, '0', 'Ah, aber, äh, war noch nicht.')], undefined, [
      'en',
      'hi',
    ]);
    expect(score).toMatchObject({
      wer: null,
      cer: null,
      foreignSegments: 1,
      languageMismatches: null,
    });
  });
});
