import { describe, expect, it } from 'vitest';
import { dropSpokenCitations, semicolonsAsSentences } from '../src/text.ts';

describe('call 8cb76efc F3: dropSpokenCitations drops OpenAI citation markers', () => {
  it('drops the marker, a stray private-use mark and the marker words left without them', () => {
    const asked = 'Would you like to start with how Yugoslavia formed?';
    expect(dropSpokenCitations(`${asked} citeturn0search1turn0search0turn0search5`)).toBe(
      asked,
    );
    expect(dropSpokenCitations(`${asked} citeturn0search1turn0search0turn0search5`)).toBe(asked);
    // A marker a segment boundary cut in two: each half is dropped where it lands.
    expect(dropSpokenCitations(`${asked} citeturn0search1`)).toBe(asked);
    expect(dropSpokenCitations('turn0search0')).toBe('');
    expect(dropSpokenCitations('In 1991 citeturn0file1L8-L13 it began.')).toBe(
      'In 1991 it began.',
    );
  });

  it('leaves ordinary words alone', () => {
    for (const text of [
      'Turn left at the turn 2 sign.',
      'Cite your sources.',
      'I return on the 5th.',
    ])
      expect(dropSpokenCitations(text)).toBe(text);
  });
});

describe('call 8cb76efc F5: a semicolon between clauses is said as a full stop', () => {
  it('turn 7', () => {
    expect(
      semicolonsAsSentences(
        'Vienna is an easy classic addition; for a quieter stop, consider Brno or Český Krumlov.',
      ),
    ).toBe(
      'Vienna is an easy classic addition. For a quieter stop, consider Brno or Český Krumlov.',
    );
  });

  it('leaves a semicolon before a number, a capital or no space alone', () => {
    for (const text of ['Gates 3; 4 and 5.', 'Open 9;30 to 6.', 'Rome; Paris; Vienna.'])
      expect(semicolonsAsSentences(text)).toBe(text);
  });
});
