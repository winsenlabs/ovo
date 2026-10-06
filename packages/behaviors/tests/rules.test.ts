import { describe, expect, it } from 'vitest';
import { AgentRules } from '@winsendotai/ovo-contracts';
import { matchesLexicon, RuleMatcher } from '../src/rules.ts';
import { normalizeUtterance } from '../src/rules-lexicons.ts';

const matcher = (rules: Record<string, unknown>) => new RuleMatcher(AgentRules.parse(rules));

describe('rule lexicons (AGT-6)', () => {
  it.each([
    ['yes', ['Yes.', 'haan ji', 'Ji haan!', 'हाँ जी', 'ஆமாங்க', 'okay sir', 'yes speaking']],
    ['no', ['No.', 'nahi ji', 'नहीं', 'இல்லை', "No, that's all"]],
    ['speaking', ['Speaking', 'haan bol raha hoon', "it's me", 'நான் தான்']],
    ['thanks', ['Thank you so much', 'dhanyavaad ji', 'शुक्रिया', 'நன்றி']],
    ['bye', ['Okay bye', 'goodbye', 'chalo bye', 'अलविदा']],
    ['repeat', ['Sorry?', 'Come again?', 'kya bola', 'phir se boliye', 'என்ன']],
    ['wait', ['Hold on', 'ek minute', 'one second please', 'ஒரு நிமிஷம்']],
  ] as const)('%s matches whole replies in English, Hindi and Tamil', (lexicon, replies) => {
    for (const reply of replies) expect(matchesLexicon(lexicon, reply), reply).toBe(true);
  });

  it('never matches a reply with a qualifier', () => {
    expect(matchesLexicon('yes', 'yes but not today')).toBe(false);
    expect(matchesLexicon('no', 'no I already paid')).toBe(false);
    expect(matchesLexicon('repeat', 'what is my due amount')).toBe(false);
  });

  it('normalises case, punctuation and spacing but keeps Indic marks', () => {
    expect(normalizeUtterance("  Haan-ji,   I'M  speaking! ")).toBe('haanji im speaking');
    expect(normalizeUtterance('जी हाँ।')).toBe('जी हाँ');
  });
});

describe('rule matcher', () => {
  it('matches phrases exactly after normalisation, and lexicons', () => {
    const rules = matcher({
      global: [
        { intent: 'intent=paid', phrases: ["I've already paid", 'paid already'] },
        { intent: 'intent=yes', lexicons: ['yes'] },
      ],
    });
    expect(rules.match('ive ALREADY paid.')).toEqual({
      intent: 'intent=paid',
      source: 'global',
      by: 'phrase',
    });
    expect(rules.match('Haan ji')?.intent).toBe('intent=yes');
    expect(rules.match('I paid it already last week')).toBeUndefined();
  });

  it('matches keywords only in short replies', () => {
    const rules = matcher({ global: [{ intent: 'intent=link', keywords: ['link', 'sms'] }] });
    expect(rules.match('send the link')?.by).toBe('keyword');
    expect(rules.match('the sms please')?.intent).toBe('intent=link');
    // Whole words only, and a long sentence is the decision model's to judge.
    expect(rules.match('linked')).toBeUndefined();
    expect(rules.match('I did not get any link from you yesterday')).toBeUndefined();
  });

  it('anchors patterns to the whole normalised reply', () => {
    const rules = matcher({
      global: [{ intent: 'intent=later', patterns: ['(pay|call) (me )?(tomorrow|later)'] }],
    });
    expect(rules.match('Call me tomorrow.')?.by).toBe('pattern');
    expect(rules.match('please call me tomorrow')).toBeUndefined();
  });

  it("tries the current listen set's rules before the global ones, in authored order", () => {
    const rules = matcher({
      global: [{ intent: 'confirm', lexicons: ['yes'] }],
      listens: {
        identity: [{ intent: 'confirmed', lexicons: ['yes', 'speaking'] }],
        link_check: [{ intent: 'received', phrases: ['got it'] }],
      },
    });
    expect(rules.match('yes', 'identity')).toEqual({
      intent: 'confirmed',
      source: 'listen',
      by: 'lexicon',
    });
    expect(rules.matches('yes', 'identity').map((match) => match.intent)).toEqual([
      'confirmed',
      'confirm',
    ]);
    expect(rules.match('yes', 'link_check')?.intent).toBe('confirm');
    expect(rules.match('yes')?.intent).toBe('confirm');
  });

  it('matches nothing when disabled, for an empty reply, or past the input cap', () => {
    expect(
      matcher({ enabled: false, global: [{ intent: 'a', lexicons: ['yes'] }] }).match('yes'),
    ).toBeUndefined();
    const rules = matcher({ global: [{ intent: 'a', patterns: ['.*'] }] });
    expect(rules.match('  ...  ')).toBeUndefined();
    expect(rules.match('x'.repeat(121))).toBeUndefined();
    expect(rules.match('x'.repeat(120))?.intent).toBe('a');
  });
});
