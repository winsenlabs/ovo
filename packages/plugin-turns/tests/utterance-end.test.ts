import { describe, expect, it } from 'vitest';
import { TurnConfigSchema } from '@winsendotai/ovo-contracts';
import { answersByItself, utteranceEnd, type UtteranceContext } from '../src/utterance-end.ts';

const context = (answering = false): UtteranceContext => ({
  language: 'en-IN',
  backchannels: TurnConfigSchema.parse({}).backchannels,
  answering,
});

describe('utteranceEnd: how the words so far end (Wave 8 smart end-of-turn)', () => {
  // Finals from the live calls (6e1a4e3a, 8cbac365, 4e4d2228).
  it.each([
    'Yeah, yeah, hi, my friend.',
    "I'm planning to go to Zagreb in Croatia. What do you know about this place?",
    'Who are the Nazis?',
    'Sometime during Christmas.',
    'हाँ।',
    'धन्यवाद, स्वागत।',
    'Hello?',
    'Oh, my God.',
    "Okay. Wait. You- Right, saying customer's here.",
    'st.',
  ])('%s is complete', (text) => {
    expect(utteranceEnd(text, context())).toBe('complete');
  });

  it.each([
    // Cut off mid-word or trailing off, as Scribe marks it.
    "You're lucky. What's the product? You didn't go there and tell me for-",
    'Promoter, sir. Promoter of CreditMantri is a...',
    'Credit. Okay, so...',
    'Do you know the…',
    // Wave 10 (call 4f1a919d turn 1): Scribe closed the quote after the trailing dots.
    '"I\'m thinking of going somewhere in middle and central Europe. Can you tell me a few places? Some..."',
    'Paris, Rome-)',
    // Call 6e1a4e3a turn 17: the ordinal's "st." became its own turn.
    "Yeah. So we'd like to leave on the 20th and be back around the 1",
    'be back around 2',
    'leave on December 2',
    'the fare is ₹500',
    'Rs 500',
    // Conjunctions, articles and hesitations, even with a full stop after them.
    'I want to go to Paris and',
    'I want to go to Paris and.',
    'mujhe paisa chahiye lekin',
    'Okay, um.',
    // A list or a clause still going, a preposition with no closing punctuation.
    'Paris, Rome,',
    'two things:',
    'I want to go to',
    'leave on December',
    'mera naam ki',
    // Wave 8b, call e8a43f65 turn 2: a date range with no month yet for its end, full stop or not.
    'I want 21st of December to the 5th.',
    'from December 21 till 5',
    'May 30th through the 2nd.',
  ])('%s is unfinished', (text) => {
    expect(utteranceEnd(text, context())).toBe('unfinished');
  });

  it('a date range is complete once its end has a month, or when it never named one', () => {
    for (const text of [
      'I want 21st of December to the 5th of January.',
      'From December 21 to January 5.',
      'From 9 to 5.',
      'I will be there on the 5th.',
      // Wave 8b review: a range within its month, and "may" that is no month.
      'Book it for December 3rd to the 5th.',
      'I may go from the 3rd to the 5th.',
    ])
      expect(utteranceEnd(text, context()), text).toBe('complete');
  });

  it.each(['Yes', 'yes', 'haan ji', 'theek hai', 'ok', 'no', 'nahi', 'hello', 'thank you', '15'])(
    '%s answers by itself, punctuated or not',
    (text) => {
      expect(utteranceEnd(text, context())).toBe('complete');
    },
  );

  it('an unpunctuated phrase gives no signal, unless it is a short reply to a question', () => {
    expect(utteranceEnd('I want to have something', context())).toBe('open');
    expect(utteranceEnd('Can you please', context())).toBe('open');
    expect(utteranceEnd('my number is 98 45', context())).toBe('open');
    expect(utteranceEnd('Zagreb', context())).toBe('open');
    expect(utteranceEnd('Zagreb', context(true))).toBe('complete');
    expect(utteranceEnd('Tejas Sudarshan', context(true))).toBe('complete');
    // Four words or a trailing preposition are no short answer, question or not.
    expect(utteranceEnd('we want to go', context(true))).toBe('open');
    expect(utteranceEnd('Zagreb in', context(true))).toBe('unfinished');
    expect(utteranceEnd('', context(true))).toBe('open');
  });

  it('only the answer lexicon answers by itself; other short replies need a VAD stop', () => {
    for (const text of ['Yes.', 'haan ji', 'हाँ।', 'Hello?', 'No', 'Oh, my God.', '15', 'okay'])
      expect(answersByItself(text, context(true))).toBe(true);
    // Review of Wave 8: each was the start of a longer reply, cut 250 ms after its interim.
    for (const text of ['My name is', 'Two adults', 'We are', 'Zagreb', 'yes I want to go'])
      expect(answersByItself(text, context(true))).toBe(false);
  });
});
