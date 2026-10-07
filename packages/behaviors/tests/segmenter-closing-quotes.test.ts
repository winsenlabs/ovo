import { describe, expect, it } from 'vitest';
import { sentenceBoundary } from '../src/sentence-boundary.ts';
import { StreamingTextSegmenter } from '../src/text-segmenter.ts';

/** Every segment a stream of deltas produces, pushes then finish, in order. */
function segments(deltas: readonly string[]): string[] {
  const segmenter = new StreamingTextSegmenter();
  return [...deltas.flatMap((delta) => segmenter.push(delta)), ...segmenter.finish()];
}

const speakable = (segment: string) => /[\p{L}\p{N}]/u.test(segment);

describe('N7: no punctuation-only segment for a closing quote', () => {
  it('keeps the curly quote with its sentence when it streams in after the mark (call bcbc7d6a)', () => {
    // Turn 7 of the Maya call: the reply's last delta was the closing quote alone, and the
    // segmenter had already cut at "?", so speech-21 was the one-character segment "”".
    const said = segments([
      'Sorry, I didn’t catch that— did you mean, “Where should we go for a short trip?',
      '”',
    ]);
    expect(said).toEqual([
      'Sorry, I didn’t catch that—',
      'did you mean, “Where should we go for a short trip?”',
    ]);
    expect(said.every(speakable)).toBe(true);
  });

  it.each([
    ['”', 'He asked, “Is it far?”'],
    ['’', 'She said ‘Wait here!’'],
    ['»', 'Il a dit « Oui? »'],
    ['"', 'Say "yes!"'],
    [')', 'Pay today (before six!)'],
  ])('holds a mark inside an open quote for its %s closer', (closer, sentence) => {
    const cut = sentence.lastIndexOf(closer);
    const said = segments([`${sentence.slice(0, cut)}`, sentence.slice(cut), ' Thanks.']);
    expect(said).toEqual([sentence, 'Thanks.']);
  });

  it('absorbs a closer the model put after a space', () => {
    expect(segments(['Did you mean “a short trip? ”', ' Tell me.'])).toEqual([
      'Did you mean “a short trip? ”',
      'Tell me.',
    ]);
  });

  it('still cuts unquoted text at a mark that ends the buffer, so first audio waits for nothing', () => {
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push('Is that okay?')).toEqual(['Is that okay?']);
    expect(segmenter.push(' Great!')).toEqual(['Great!']);
  });

  it('cuts an open quote at a flush: the reply is over', () => {
    expect(segments(['He said “stop?'])).toEqual(['He said “stop?']);
    expect(sentenceBoundary('He said “stop?', 240, 'en', true, false)).toBe(14);
    expect(sentenceBoundary('He said “stop?', 240, 'en', false, false)).toBeUndefined();
  });

  it('does not take an apostrophe for an open quote', () => {
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push('I didn’t get that, can you repeat?')).toEqual([
      'I didn’t get that,',
      'can you repeat?',
    ]);
  });
});
