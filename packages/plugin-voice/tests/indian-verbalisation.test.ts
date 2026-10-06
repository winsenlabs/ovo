import { describe, expect, it } from 'vitest';
import type { TextFilter } from '@winsendotai/ovo-contracts';
import {
  BoundedSpeechScheduler,
  createIndianVerbalisationTextFilterPlugin,
  filterSpeechText,
  indianNumberWords,
  indianVerbalisationFilter,
  INDIAN_VERBALISATION_FILTER_ID,
  markdownFilter,
  plugins,
  urlFilter,
} from '../src/index.ts';

const speak = (text: string, language = 'en-IN') =>
  indianVerbalisationFilter.apply(text, { language });

describe('Indian verbalisation text filter', () => {
  it.each([
    [0, 'zero'],
    [7, 'seven'],
    [42, 'forty-two'],
    [105, 'one hundred and five'],
    [4_850, 'four thousand eight hundred and fifty'],
    [1_00_005, 'one lakh and five'],
    [12_34_567, 'twelve lakh thirty-four thousand five hundred and sixty-seven'],
    [2_50_00_000, 'two crore fifty lakh'],
    [
      1_23_45_67_890,
      'one hundred and twenty-three crore forty-five lakh sixty-seven thousand eight hundred and ninety',
    ],
  ])('groups %i the Indian way', (value, words) => {
    expect(indianNumberWords(value)).toBe(words);
  });

  it.each([
    [
      'Your EMI of ₹4,850 is due.',
      'Your EMI of four thousand eight hundred and fifty rupees is due.',
    ],
    [
      'Pay Rs. 1,23,450.50 today.',
      'Pay one lakh twenty-three thousand four hundred and fifty rupees and fifty paise today.',
    ],
    ['A charge of INR 500/- applies.', 'A charge of five hundred rupees applies.'],
    ['Only ₹1 left.', 'Only one rupee left.'],
    ['₹0.75 is pending.', 'seventy-five paise is pending.'],
    ['A loan of ₹1.5 lakh.', 'A loan of one point five lakh rupees.'],
    ['Settle 2,000 rupees.', 'Settle two thousand rupees.'],
  ])('speaks amounts: %s', (text, spoken) => {
    expect(speak(text)).toBe(spoken);
  });

  it.each([
    ['Due on 05/10/2026.', 'Due on the 5th of October, twenty twenty-six.'],
    ['Due on 2026-10-05.', 'Due on the 5th of October, twenty twenty-six.'],
    ['Paid on 1-1-2009.', 'Paid on the 1st of January, two thousand nine.'],
    ['by 22nd Oct 2026', 'by the 22nd of October, twenty twenty-six'],
    ['by 3 March', 'by the 3rd of March'],
    ['Not a date: 31/02/2026.', 'Not a date: 31/02/2026.'],
  ])('speaks en-IN dates: %s', (text, spoken) => {
    expect(speak(text)).toBe(spoken);
  });

  it.each([
    [
      'Call +91 98765 43210.',
      'Call plus nine one, nine eight seven six five, four three two one zero.',
    ],
    ['Call 9876543210.', 'Call nine eight seven six five, four three two one zero.'],
    [
      'Toll free 1800-123-4567.',
      'Toll free one eight zero zero, one two three, four five six seven.',
    ],
    ['Branch 080-41234567.', 'Branch zero eight zero, four one two three four five six seven.'],
  ])('speaks phone numbers digit by digit: %s', (text, spoken) => {
    expect(speak(text)).toBe(spoken);
  });

  it('leaves non-English text alone and reads dates only for en-IN', () => {
    expect(speak('₹4,850 बाकी है', 'hi-IN')).toBe('₹4,850 बाकी है');
    expect(speak('Due 05/10/2026, ₹10.', 'en-US')).toBe('Due 05/10/2026, ten rupees.');
  });

  it('is a first-party text-filter plugin in the voice inventory', () => {
    const plugin = createIndianVerbalisationTextFilterPlugin();
    expect(plugin.manifest.id).toBe(INDIAN_VERBALISATION_FILTER_ID);
    expect(plugins.map((item) => item.manifest.id)).toContain(INDIAN_VERBALISATION_FILTER_ID);
  });
});

describe('filterSpeechText (TTS-6)', () => {
  it('applies filters in the scheduler order whatever order they are given', async () => {
    const shout: TextFilter = { id: 'z-shout', order: 10, apply: (text) => text.toUpperCase() };
    const filters = [indianVerbalisationFilter, urlFilter, shout, markdownFilter];
    const raw = 'Pay **₹4,850** at https://pay.example.in';
    const expected = filterSpeechText(filters, raw, 'en-IN');
    // markdown (10, "@…" sorts first) → shout (10) → url (20) → Indian verbalisation (30).
    expect(expected).toBe(
      'PAY four thousand eight hundred and fifty rupees AT PAY dot EXAMPLE dot IN',
    );
    const spoken: string[] = [];
    const scheduler = new BoundedSpeechScheduler({
      async play(segment) {
        spoken.push(segment.text);
        return { state: 'completed', evidence: 'simulated' };
      },
      async interrupt() {},
    });
    scheduler.configureFilters(filters, 'en-IN');
    await scheduler.speak(raw);
    expect(spoken).toEqual([expected]);
  });
});
