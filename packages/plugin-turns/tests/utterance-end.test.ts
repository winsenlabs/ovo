import { describe, expect, it } from 'vitest';
import { TurnConfigSchema } from '@winsendotai/ovo-contracts';
import { utteranceEnd, type UtteranceContext } from '../src/utterance-end.ts';

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
  ])('%s is unfinished', (text) => {
    expect(utteranceEnd(text, context())).toBe('unfinished');
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
});
