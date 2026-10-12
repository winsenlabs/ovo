import { describe, expect, it } from 'vitest';
import { continuesUtterance, listsItems, pausesMidThought, statesPlans } from '../src/index.ts';

// Wave 8b: the caller lines of Maya call e8a43f65 (2026-10-12) and the Wave 8 follow-ups.
describe('words that carry on the caller’s last utterance', () => {
  it('reads the call’s continuations as such', () => {
    for (const [later, earlier] of [
      ['Of January.', 'I want 21st of December to the 5th.'],
      ["in Austria. Then we're planning to go to Zagreb, Prague.", 'Budapest, Vienna,'],
      [
        'Germany, Berlin, and a few other places.',
        "Yeah, we're planning to do Budapest, Vienna, in Austria. Then we're planning to go to Zagreb, Prague.",
      ],
      // Any words after an utterance that broke off on a comma.
      ['Prague.', 'Budapest, Vienna,'],
      ['And in Split.', 'What is the weather in Zagreb?'],
      ['st.', 'Yeah. So we would like to be back around the 1'],
    ])
      expect(continuesUtterance(later, earlier), later).toBe(true);
  });

  it('reads new sentences, and a lower-case word from an STT that never capitalises, as not', () => {
    for (const [later, earlier] of [
      ['Oh, my God.', 'Yeah.'],
      ['Actually, flights to Munich instead.', 'Yeah.'],
      ['Yes, Zagreb.', 'Rome, Paris.'],
      ['Germany, Berlin, and a few other places.', 'I like it.'],
      ['austria then prague', 'budapest and vienna'],
      ['', 'Budapest, Vienna,'],
    ])
      expect(continuesUtterance(later, earlier), later).toBe(false);
  });

  it('reads a list of three or more short items, asides not counted', () => {
    expect(listsItems('Germany, Berlin, and a few other places.')).toBe(true);
    expect(listsItems('We go to Rome. Then Paris, Vienna or Prague.')).toBe(true);
    expect(listsItems('Two checks, sir, yes. Those dates are correct.')).toBe(false);
    expect(listsItems("Yeah, we're planning to do Budapest, Vienna,")).toBe(false);
    expect(listsItems('Rome and Paris')).toBe(false);
  });
});

describe('statements of the caller’s plans, which ask nothing to look up (issue 3)', () => {
  it('reads plans, dates, lists and confirmations as statements', () => {
    for (const text of [
      '"We\'re planning to go to Zagreb this..." No, December.',
      'I want 21st of December to the 5th.',
      'I want 21st of December to the 5th. Of January.',
      "Yeah, we're planning to do Budapest, Vienna, in Austria. Then we're planning to go to Zagreb, Prague.",
      'Germany, Berlin, and a few other places.',
      'December 21st to January 5th.',
      "Yes, that's right.",
      "I'm in a coffee shop.",
      "We're flying back on the 5th.",
      'I am at the airport.',
    ])
      expect(statesPlans(text), text).toBe(true);
  });

  it('never reads a question, a request or a follow-up with no subject as one', () => {
    for (const text of [
      "We're planning to go to Zagreb in December. What's the weather like?",
      'I would like recommendations for Lisbon.',
      'And in Split.',
      'Restaurants near the Colosseum.',
      'Euro exchange rate today.',
      'Tomorrow.',
      "Ma'am, create a call.",
      'Listen to me. Listen to me, please.',
      'Credit. Okay, so...',
      '',
      // First person, but saying what they look for or want, not their plans.
      "I'm looking for a good restaurant in Zagreb.",
      "We're looking for things to do in Prague.",
      'I want restaurants near the Colosseum.',
      "I'm curious whether the museums are open on Christmas Day.",
      'We want to see the Christmas markets in Vienna.',
      'I need a hotel in Vienna.',
    ])
      expect(statesPlans(text), text).toBe(false);
  });
});

// Wave 9, issue D3: the caller lines of Maya call 10d5ef30 (2026-10-12) that stopped mid-thought.
describe('words that stop mid-thought', () => {
  it('reads a hesitation, an article or an open preposition as the caller still thinking', () => {
    for (const text of [
      'No, umm...',
      'And stuff like that. I mean, it should still be a',
      '"Hey, Maya, can you please tell me what places are nice in-"',
      'Uh, I expect to fly out on...',
      "Yeah, I don't mind, but, uh,",
      'It should still be a.',
      'So, yeah, a...',
      'अम्म...',
    ])
      expect(pausesMidThought(text), text).toBe(true);
  });

  it('never reads a closed sentence, a letter, a number or a list as one', () => {
    for (const text of [
      'Where are you from?',
      "Yes, I'm in.",
      'We will take plan A.',
      'Never mind. Thank you.',
      'I want to come back around the 1',
      'Budapest, Vienna,',
      'built-in.',
      '',
    ])
      expect(pausesMidThought(text), text).toBe(false);
  });
});
