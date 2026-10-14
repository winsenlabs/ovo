import { describe, expect, it } from 'vitest';
import { filterSpeechText, normaliseSpeechText, speakerTextFilters } from '../src/index.ts';

/**
 * Wave 12 (Maya call 8cb76efc): the speech normaliser, which every speaker applies (Wave 9 D1), is
 * the guarantee behind the OpenAI binding's stripping (F3) and the agent stream's sentence breaks
 * (F5), for any text that reaches the TTS without them.
 */
describe('call 8cb76efc: what the TTS is given', () => {
  const marker = 'citeturn0search1turn0search0turn0search5';

  it('F3: never a citation marker, in any language', () => {
    const asked = 'Would you like to start with how Yugoslavia formed?';
    expect(normaliseSpeechText(`${asked} ${marker}`, 'en-IN')).toBe(asked);
    expect(normaliseSpeechText(`क्या आप और जानना चाहेंगे? ${marker}`, 'hi-IN')).toBe(
      'क्या आप और जानना चाहेंगे?',
    );
    // Through a speaker's whole filter chain, with no filter of the agent's own.
    expect(filterSpeechText(speakerTextFilters([]), `${asked} ${marker}`, 'en-IN')).toBe(asked);
  });

  it('F5: a semicolon between clauses ends a sentence', () => {
    expect(
      normaliseSpeechText(
        'and Vienna is an easy classic addition; for a quieter stop, consider Brno.',
        'en-IN',
      ),
    ).toBe('and Vienna is an easy classic addition. For a quieter stop, consider Brno.');
  });
});
