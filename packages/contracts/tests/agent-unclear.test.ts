import { describe, expect, it } from 'vitest';
import {
  acknowledgementOnly,
  affirmationOnly,
  AgentConfig,
  AgentUnclear,
  callerPunctuation,
  cutOffWords,
  lowInformation,
  seeksInformation,
} from '../src/index.ts';

// The caller lines of Maya call 6e1a4e3a (2026-10-08, a noisy café) and of the 2026-10-07 calls.
describe('what a caller’s words carry (call-3 #2, #3)', () => {
  it('reads acknowledgements, exclamations, greetings and thanks as asking nothing', () => {
    for (const text of [
      'Yeah.',
      'Oh, my God.',
      'Hmm, okay.',
      'Hello?',
      'Hello? Hello?',
      'Yeah, yeah, hi, my friend.',
      'Okay. Thank you, Danny.',
      'Thank you.',
      'Wait. Hold on.',
      'No, no.',
      'हाँ।',
      'अच्छा।',
      'சரி.',
    ])
      expect(acknowledgementOnly(text), text).toBe(true);
    for (const text of [
      '',
      '?!',
      "I'm in a coffee shop.",
      'Tell me about the Hamburg as well.',
      'Two checks, sir, yes. Those dates are correct.',
      'Thank you, but which train is faster?',
    ])
      expect(acknowledgementOnly(text), text).toBe(false);
  });

  it('reads a bare yes, in English, Hinglish, Hindi and Tamil', () => {
    for (const text of ['Yes.', 'Yeah.', 'Haan ji.', 'हाँ।', 'जी', 'Yes sir, okay.', 'ஆமா'])
      expect(affirmationOnly(text), text).toBe(true);
    for (const text of ['No.', 'Yes, Zagreb.', 'Oh, my God.', 'Thank you.', 'Hmm.', ''])
      expect(affirmationOnly(text), text).toBe(false);
  });

  it('reads questions and requests as asking, and a lone word with a question mark as not', () => {
    for (const text of [
      'Who are the Nazis?',
      "I'm planning to go to Zagreb in Croatia. What do you know about this place?",
      'No. Can you check for flights from Chennai to Frankfurt?',
      'Hmm, okay. So, tell me more about Nuremberg.',
      'I am Indian vegetarian. Can I get food there?',
      'Is it open?',
      'Weather Zagreb',
      'Ticket kitna hai?',
      'यह क्या है?',
    ])
      expect(seeksInformation(text), text).toBe(true);
    for (const text of [
      'Hardik?',
      'Hello?',
      'Hello? Hello?',
      'हाँ।',
      "Ma'am, they seem like nice people.",
      'Sometime during Christmas.',
      'Credit. Okay, so...',
      "I'm in a coffee shop.",
    ])
      expect(seeksInformation(text), text).toBe(false);
  });

  it('reads words too unclear or too thin to answer, and a statement as not', () => {
    for (const text of [
      'हाँ।',
      'Hardik?',
      'Credit.',
      'Credit. Okay, so...',
      'जानकार, जानकार। एक लाख...',
      'Oh, my God.',
      '?!',
    ])
      expect(lowInformation(text), text).toBe(true);
    for (const text of [
      'And in Split.',
      'Restaurants near the Colosseum.',
      'Zagreb, in December.',
      'Two checks, sir, yes. Those dates are correct.',
      'Weather?',
      'Who are the Nazis?',
    ])
      expect(lowInformation(text), text).toBe(false);
  });

  it('reads the punctuation that changes how words are answered', () => {
    expect(callerPunctuation('Is the museum open?')).toEqual([true, false]);
    expect(callerPunctuation('Is the museum open.')).toEqual([false, false]);
    expect(callerPunctuation('Tell me about-')).toEqual([false, true]);
  });

  it('reads a turn the STT cut off', () => {
    for (const text of [
      'Credit. Okay, so...',
      'Hello, if madam...',
      "I don't know, tell me about-",
      'जानकार, जानकार। एक लाख...',
    ])
      expect(cutOffWords(text), text).toBe(true);
    for (const text of ['Yes.', 'Who are the Nazis?', 'st.'])
      expect(cutOffWords(text), text).toBe(false);
  });
});

describe('unclear (agent config)', () => {
  it('takes one to five lines, in agent mode only', () => {
    expect(AgentUnclear.safeParse({ lines: [] }).success).toBe(false);
    expect(AgentUnclear.safeParse({ lines: ['Pardon?'], extra: 1 }).success).toBe(false);
    expect(
      AgentConfig.safeParse({ name: 'A', mode: 'agent', unclear: { lines: ['Pardon?'] } }).success,
    ).toBe(true);
    expect(
      AgentConfig.safeParse({ name: 'A', mode: 'context', unclear: { lines: ['Pardon?'] } })
        .success,
    ).toBe(false);
  });
});
