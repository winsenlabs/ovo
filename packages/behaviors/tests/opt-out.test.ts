import { describe, expect, it, vi } from 'vitest';
import { CallOptOut, detectsOptOut, OPT_OUT_DISPOSITION, optOutPolicy } from '../src/opt-out.ts';
import { disclosureLine, disclosureSpeechKind, withDisclosure } from '../src/disclosure.ts';

describe('opt-out intent', () => {
  it.each([
    'Please stop calling me, I already paid.',
    "Don't call me again!",
    'Take me off your list',
    'mujhe call mat karo',
    'Dobara call mat karna',
    'मुझे कॉल मत करो',
    'दोबारा फोन मत करना',
    'inimel call pannadheenga',
    'I told you before, stop calling me',
    'kab tak call karoge, mujhe call mat karo',
  ])('hears "%s" as an opt-out', (text) => {
    expect(detectsOptOut(text)).toBe(true);
  });

  it.each([
    "Don't call me now, call me tomorrow",
    'abhi call mat karo, baad mein karna',
    'stop',
    'I will pay by Friday',
    '',
    'calling',
  ])('does not hear "%s" as an opt-out', (text) => {
    expect(detectsOptOut(text)).toBe(false);
  });

  // Regression: each of these asks for a later call, and was heard as a permanent opt-out (which
  // lists the number on the do-not-call list for good) while the phrase alone decided.
  it.each([
    'abhi mujhe call mat karo, main busy hoon',
    'mujhe call mat karo abhi, baad mein karna',
    'अभी मुझे कॉल मत करो',
    'mujhe phone mat karo office time pe',
    'stop calling me at work, call me in the evening',
    'dont call me again today, I will pay tomorrow',
    'Never call me before 10am',
    'never call me before ten',
    'mujhe call mat karo, 5 baje ke baad karna',
  ])('hears the deferral in "%s", not an opt-out', (text) => {
    expect(detectsOptOut(text)).toBe(false);
  });

  it.each([
    "Don't ever call me again, not today, not tomorrow",
    'Take me off your list, I am busy',
    'aaj ke baad mujhe call mat karna',
    'From now on stop calling me',
    'abhi se mujhe kabhi bhi call mat karna',
    'मुझे अभी से कभी कॉल मत करना',
  ])('lets a permanent ask in "%s" win over a deferral word', (text) => {
    expect(detectsOptOut(text)).toBe(true);
  });

  it('vetoes authored phrases with a deferral word too', () => {
    expect(detectsOptOut('band karo yeh calls', ['band karo yeh'])).toBe(true);
    expect(detectsOptOut('abhi band karo yeh calls', ['band karo yeh'])).toBe(false);
  });

  it('adds authored phrases, matched as whole words', () => {
    expect(detectsOptOut('Band karo yeh sab', ['band karo yeh'])).toBe(true);
    expect(detectsOptOut('bandkaro', ['band karo'])).toBe(false);
  });

  it('reads the policy structurally and is off without one or when disabled', () => {
    expect(optOutPolicy({})).toBeUndefined();
    expect(optOutPolicy({ compliance: { optOut: { enabled: false } } })).toBeUndefined();
    expect(optOutPolicy({ compliance: { optOut: { enabled: true, phrases: ['bas'] } } })).toEqual({
      enabled: true,
      phrases: ['bas'],
      closingLine: expect.stringContaining("won't call this number again"),
    });
  });

  it('records the opted_out disposition once, from the rules tier', () => {
    const append = vi.fn(async () => undefined);
    const optOut = new CallOptOut(
      { compliance: { optOut: { enabled: true, phrases: [], closingLine: 'Okay, goodbye.' } } },
      { append },
    );
    expect(optOut.heard('I will pay tomorrow', 1)).toBe(false);
    expect(optOut.optedOut).toBe(false);
    expect(optOut.heard('stop calling me', 2)).toBe(true);
    expect(optOut.heard('stop calling me!', 3)).toBe(true);
    expect(optOut.optedOut).toBe(true);
    expect(optOut.closingLine).toBe('Okay, goodbye.');
    expect(append).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith('disposition', {
      disposition: OPT_OUT_DISPOSITION,
      turn: 2,
      source: 'rule',
      reason: 'caller_opt_out',
    });
  });

  it('never opts out an agent without the policy', () => {
    const optOut = new CallOptOut({ name: 'No compliance' });
    expect(optOut.heard('stop calling me', 1)).toBe(false);
    expect(optOut.optedOut).toBe(false);
  });
});

describe('recording disclosure', () => {
  const config = { compliance: { disclosure: { text: 'This call is recorded.' } } };

  it('puts the disclosure before the opening lines', () => {
    expect(withDisclosure(config, [{ field: 'opening.lines.0', text: 'Hello {{name}}' }])).toEqual([
      { field: 'compliance.disclosure', text: 'This call is recorded.' },
      { field: 'opening.lines.0', text: 'Hello {{name}}' },
    ]);
    expect(withDisclosure({}, [])).toEqual([]);
  });

  it('marks only the disclosure line as protected disclosure speech', () => {
    expect(disclosureLine(config)).toBe('This call is recorded.');
    expect(disclosureLine({ compliance: { disclosure: { text: '  ' } } })).toBeUndefined();
    expect(disclosureSpeechKind(config, 'This call is recorded.')).toBe('disclosure');
    expect(disclosureSpeechKind(config, 'Hello')).toBeUndefined();
    expect(disclosureSpeechKind({}, 'This call is recorded.')).toBeUndefined();
  });
});
