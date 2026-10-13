import { describe, expect, it } from 'vitest';
import type { TextFilter } from '@winsendotai/ovo-contracts';
import { splitsSpeechUnit } from '../src/engine/speech-units.ts';
import {
  createSpeechNormaliserFilter,
  filterSpeechText,
  indianVerbalisationFilter,
  markdownFilter,
  normaliseSpeechText,
  urlFilter,
} from '../src/index.ts';

/**
 * Wave 10, B4: Maya call 4f1a919d (2026-10-13, en-IN). Turn 10 ("20. December 20th or 21st?") was
 * answered "For the 20th of December or 21, 2026, Lufthansa’s schedule shows nonstop Chennai to
 * Frankfurt flights…" (speech-31), and the TTS read the "or 21, 2026" as written.
 */
const CALL_DAY = Date.parse('2026-10-13T07:52:25Z');
const say = (text: string, language = 'en-IN') =>
  normaliseSpeechText(text, language, { now: () => CALL_DAY });

describe('call 4f1a919d B4: two days of a month, offered as a choice or named together', () => {
  it('speech-31 as the model wrote it: "the 20th or 21st of December", the year dropped', () => {
    const filters: TextFilter[] = [
      markdownFilter,
      urlFilter,
      createSpeechNormaliserFilter({ now: () => CALL_DAY }),
      indianVerbalisationFilter,
    ];
    // Before: unchanged ("…December or 21, 2026, Lufthansa’s…").
    expect(
      filterSpeechText(
        filters,
        'For the 20th of December or 21, 2026, Lufthansa’s schedule shows nonstop Chennai to Frankfurt flights.',
        'en-IN',
      ),
    ).toBe(
      'For the 20th or 21st of December, Lufthansa’s schedule shows nonstop Chennai to Frankfurt flights.',
    );
  });

  it('says every way of writing it the one way', () => {
    for (const written of [
      'December 20 or 21, 2026',
      'December 20th or 21st',
      'December 20 or the 21st',
      '20 or 21 December',
      '20th or 21st December 2026',
      'the 20th or the 21st of December',
      'the 20th of December or 21st',
    ])
      expect(say(`Fly on ${written}.`), written).toBe('Fly on the 20th or 21st of December.');
    expect(say('December 20 and 21 are both open.')).toBe(
      'the 20th and 21st of December are both open.',
    );
    expect(say('Both 20 and 21 December, 2026.')).toBe('Both the 20th and 21st of December.');
    // A dash is still a range (Wave 9).
    expect(say('December 20th–21st.')).toBe('the 20th to the 21st of December.');
  });

  it('keeps the month first in en-US, and is idempotent', () => {
    expect(say('Fly on December 20 or 21, 2026.', 'en-US')).toBe('Fly on December 20th or 21st.');
    expect(say('Fly on 20 or 21 December.', 'en-US')).toBe('Fly on December 20th or 21st.');
    for (const text of ['Fly on the 20th or 21st of December.', 'Fly on December 20th or 21st.'])
      expect(say(say(text, 'en-US'), 'en-US')).toBe(say(text, 'en-US'));
    expect(say(say('For the 20th of December or 21, 2026, fly.'))).toBe(
      'For the 20th or 21st of December, fly.',
    );
  });

  it('leaves counts, the same day twice and a year a caller would not assume alone', () => {
    expect(say('December 20 and 21 guests.')).toBe('the 20th of December and 21 guests.');
    expect(say('On December 20 or 2 nights later.')).toBe(
      'On the 20th of December or 2 nights later.',
    );
    expect(say('December 20 or 20.')).toBe('the 20th of December or 20.');
    expect(say('December 20 or 21, 2027.')).toBe('the 20th or 21st of December 2027.');
  });

  it('leaves amounts, counts of anything and a second month to their own words', () => {
    // Review of b0b5ae2: each was read as a second day of the month (Wave 9 said them all right).
    expect(say('Your payment of December 5 and 1,500 rupees is due.')).toBe(
      'Your payment of the 5th of December and 1,500 rupees is due.',
    );
    expect(say('Pay by December 5 and 3 instalments remain.')).toBe(
      'Pay by the 5th of December and 3 instalments remain.',
    );
    expect(say('On December 20 and 3 hotels nearby have rooms.')).toBe(
      'On the 20th of December and 3 hotels nearby have rooms.',
    );
    expect(say('We fly December 31 or 1 January.')).toBe(
      'We fly the 31st of December or the 1st of January.',
    );
    // A bare second day is a day only before a year, the clause's end or a verb taking both.
    expect(say('December 20 or 3.')).toBe('the 20th of December or 3.');
    expect(say('December 20 or 21 for the flight.')).toBe(
      'the 20th of December or 21 for the flight.',
    );
    expect(say('December 20 and 21.')).toBe('the 20th and 21st of December.');
  });

  it('holds a long line the segmenter cut before the second day', () => {
    const long = 'Lufthansa flies nonstop from Chennai to Frankfurt most days of the week, ';
    expect(splitsSpeechUnit(`${long}${long}so try December 20 or`)).toBe(true);
    expect(splitsSpeechUnit('Try December 20 or')).toBe(false);
  });
});
