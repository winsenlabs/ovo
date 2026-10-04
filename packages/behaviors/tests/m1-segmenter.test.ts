import { describe, expect, it } from 'vitest';
import { StreamingTextSegmenter } from '../src/text-segmenter.ts';

describe('multilingual streaming sentence boundaries', () => {
  it.each([
    ['नमस्ते।आप कैसे हैं॥', ['नमस्ते।', 'आप कैसे हैं॥']],
    ['你好。你好吗？再见！', ['你好。', '你好吗？', '再见！']],
    ['مرحبا۔كيف حالك؟', ['مرحبا۔', 'كيف حالك؟']],
  ])('segments %s without requiring ASCII whitespace', (text, expected) => {
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push(text as string)).toEqual(expected);
    expect(segmenter.finish()).toEqual([]);
  });

  it('waits for lookahead and preserves titles, currency abbreviations and decimals', () => {
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push('Dr. ')).toEqual([]);
    expect(segmenter.push('Smith paid Rs. ')).toEqual([]);
    expect(segmenter.push('3.5 today. ')).toEqual([]);
    expect(segmenter.push('Next sentence.')).toEqual(['Dr. Smith paid Rs. 3.5 today.']);
    expect(segmenter.finish()).toEqual(['Next sentence.']);
  });

  it('flushes a short first clause at a comma but keeps numeric grouping intact', () => {
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push('The amount is 1,000 rupees, and the receipt follows.')).toEqual([
      'The amount is 1,000 rupees,',
    ]);
    expect(segmenter.finish()).toEqual(['and the receipt follows.']);
  });
});

it('preserves numeric grouping across provider chunk boundaries', () => {
  const segmenter = new StreamingTextSegmenter();
  expect(segmenter.push('Pay 1,')).toEqual([]);
  expect(segmenter.push('000 rupees, please.')).toEqual(['Pay 1,000 rupees,']);
  expect(segmenter.finish()).toEqual(['please.']);
});
