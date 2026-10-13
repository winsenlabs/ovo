import { describe, expect, it } from 'vitest';
import {
  answersEnding,
  closesConversation,
  declinesWithThanks,
  endingLines,
  expectsShortReply,
} from '../src/index.ts';

/**
 * Wave 10: Maya call 4f1a919d (2026-10-13, main 54fd9ea). Turn 11, after "…Which day works better
 * for you?", was "No, okay, I'll take it later. Thank you so much." (B3): the model ended the call
 * and the gate asked "Shall I end the call?" instead; the caller's "Yeah, yeah." (turn 12) then
 * waited 1.58 s for the model to be told goodbye (L2).
 */
describe('call 4f1a919d B3: a decline put off with thanks', () => {
  it('reads turn 11 and its kind as a decline with thanks', () => {
    for (const text of [
      "No, okay, I'll take it later. Thank you so much.",
      "No, I'll book it later, thanks.",
      'No. Maybe later. Thank you.',
      'Nope, not now, thanks a lot.',
      "No no, I'll think about it. Thank you, sir.",
      'Nahi, baad mein. Thank you.',
      'Okay, no, we will do that later. Thank you.',
      // As STT writes it without punctuation.
      "no okay i'll take it later thank you so much",
    ])
      expect(declinesWithThanks(text), text).toBe(true);
  });

  it('leaves what is no closing alone, the Wave 9 negatives among them', () => {
    for (const text of [
      // Thanks not last, or no decline first.
      "No, okay, I'll take it later.",
      "Thank you, I'll take it later.",
      "I'll take it later. Thank you.",
      // A bare "No thanks." declines the offer only (Wave 9): the caller may go on.
      'No thanks.',
      // Anything that asks, or words that are no put-off.
      "No, I'll take it later. Thank you. And what about hotels?",
      "No, I'll book it later. Thank you. Can you send me the link.",
      "No, I'll take the train. Thank you.",
      // Wave 9 (D4): "How are you?" answered, and Hinglish "kuch nahi" / "bas" in a sentence.
      "I'm fine, thank you.",
      'Thank you. Mujhe kuch nahi samjha.',
      'Thank you, bas ek sawal hai.',
      "Thank you, I'm okay with that plan, book it",
    ])
      expect(declinesWithThanks(text), text).toBe(false);
  });

  it('keeps closesConversation as Wave 9 left it', () => {
    expect(closesConversation("No, I'm good. Thank you.")).toBe(true);
    expect(closesConversation('Never mind. Thank you.')).toBe(true);
    expect(closesConversation('No thanks.')).toBe(false);
    expect(closesConversation("I'm fine, thank you.")).toBe(false);
  });
});

describe('call 4f1a919d L2: a plain yes or no to "Shall I end the call?"', () => {
  it('reads a yes, alone or with thanks or a goodbye', () => {
    for (const text of [
      'Yeah, yeah.',
      'Yeah, yeah, please.',
      'Yes.',
      'Okay.',
      'Yes, end it.',
      'Sure, thank you so much.',
      'Yes, bye.',
      'Okay, bye bye.',
      'Haan ji.',
      'हाँ जी',
    ])
      expect(answersEnding(text), text).toBe('yes');
  });

  it('reads a no, alone', () => {
    for (const text of ['No.', 'No, no.', 'Not yet.', 'Wait.', 'Nahi.', 'नहीं'])
      expect(answersEnding(text), text).toBe('no');
  });

  it('leaves anything more to the model', () => {
    for (const text of [
      'Yes, but first tell me about hotels.',
      'No, thank you.',
      'No, one more question.',
      'Yes?',
      'Thank you.',
      'Hmm.',
      'Madras.',
    ])
      expect(answersEnding(text), text).toBeUndefined();
  });

  it('has fixed lines in English and Hindi, and none for other languages', () => {
    expect(endingLines('en-IN')).toEqual({
      ask: 'Shall I end the call?',
      goodbye: 'Thank you for your time. Goodbye!',
      resume: 'Sure. What else can I help you with?',
    });
    expect(endingLines('hi')?.ask).toBe('क्या मैं कॉल खत्म कर दूँ?');
    expect(endingLines('ta')).toBeUndefined();
  });
});

describe('call 4f1a919d L3: words whose reply is a few words', () => {
  it('reads acknowledgements, yeses and noes, confirmations, thanks and closings', () => {
    for (const text of [
      'Okay.',
      'Yeah, yeah.',
      'No, no.',
      "Yes, that's right.",
      'Thank you.',
      'Okay, bye.',
      'Never mind. Thank you.',
      "No, okay, I'll take it later. Thank you so much.",
    ])
      expect(expectsShortReply(text), text).toBe(true);
  });

  it('reads questions, places and plans as not', () => {
    for (const text of [
      'Madras.',
      'Chennai, Chennai.',
      'Hello, Frankfurt.',
      '20. December 20th or 21st?',
      'What are ruin bars?',
      'I want 21st of December to the 5th.',
    ])
      expect(expectsShortReply(text), text).toBe(false);
  });
});
