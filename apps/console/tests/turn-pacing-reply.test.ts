import { describe, expect, it } from 'vitest';
import { withMinFirstWords } from '../components/studio/turn-pacing-editor';

// Wave 8: `reply` gained the first phrase and the long-answer cap; editing the one knob this
// editor shows used to replace the whole object and drop them.
describe('the words-before-the-first-clause-break field', () => {
  it("keeps the agent's other reply settings", () => {
    const reply = { minFirstWords: 3, maxSentences: 0, moreLine: 'More?' };
    expect(withMinFirstWords(reply, '5')).toEqual({
      minFirstWords: 5,
      maxSentences: 0,
      moreLine: 'More?',
    });
    expect(withMinFirstWords(reply, '')).toEqual({ maxSentences: 0, moreLine: 'More?' });
  });

  it('bounds the value, and leaves no empty reply behind', () => {
    expect(withMinFirstWords(undefined, '40')).toEqual({ minFirstWords: 12 });
    expect(withMinFirstWords({ minFirstWords: 4 }, '')).toBeUndefined();
  });
});
