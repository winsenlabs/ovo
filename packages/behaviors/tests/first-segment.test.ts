import { describe, expect, it } from 'vitest';
import { StreamingTextSegmenter } from '../src/text-segmenter.ts';

const segment = (text: string, options = {}) => {
  const segmenter = new StreamingTextSegmenter(undefined, undefined, options);
  return [...segmenter.push(text), ...segmenter.finish()];
};

describe('LAT-9 first-segment splitting', () => {
  it('does not cut a lone "Okay," but cuts the first clause of three words or more', () => {
    expect(segment('Okay, so your EMI is due on the fifth. You can pay online.')).toEqual([
      'Okay, so your EMI is due on the fifth.',
      'You can pay online.',
    ]);
    expect(segment('Sure Rahul ji, your EMI of 4,500 rupees is due on the fifth.')).toEqual([
      'Sure Rahul ji,',
      'your EMI of 4,500 rupees is due on the fifth.',
    ]);
    // The old rule, for comparison: any comma ends the first segment.
    expect(segment('Okay, so your EMI is due.', { minFirstWords: 0 })).toEqual([
      'Okay,',
      'so your EMI is due.',
    ]);
  });

  it('also cuts the first segment at a semicolon, a colon or an em dash, never later ones', () => {
    expect(segment('I checked your account; the EMI is due, as before.')).toEqual([
      'I checked your account;',
      'the EMI is due, as before.',
    ]);
    expect(segment('Here is the plan: pay half now; the rest later.')).toEqual([
      'Here is the plan:',
      'pay half now; the rest later.',
    ]);
    expect(segment('I checked it — your EMI is due.')).toEqual([
      'I checked it —',
      'your EMI is due.',
    ]);
  });

  it('keeps a time of day whole, also when its minutes have not streamed in yet', () => {
    const segmenter = new StreamingTextSegmenter();
    expect(segmenter.push('We will call you at 10:')).toEqual([]);
    expect(segmenter.push('30 tomorrow, if that works.')).toEqual([
      'We will call you at 10:30 tomorrow,',
    ]);
    expect(segmenter.finish()).toEqual(['if that works.']);
  });

  it('rejects a negative word minimum', () => {
    expect(() => new StreamingTextSegmenter(undefined, undefined, { minFirstWords: -1 })).toThrow(
      'minFirstWords',
    );
  });
});

/**
 * A deterministic timeline: the model streams one word every `wordMs`, a segment is sent to TTS
 * when the segmenter releases it, its audio starts `ttfbMs` later and lasts `msPerChar` per
 * character, and segments play back to back. The numbers are fixtures, not measurements.
 */
function timeline(reply: string, options: { minFirstWords?: number }) {
  const wordMs = 40;
  const ttfbMs = 250;
  const msPerChar = 60;
  const segmenter = new StreamingTextSegmenter(undefined, undefined, options);
  const ready: { text: string; at: number }[] = [];
  const words = reply.split(' ');
  words.forEach((word, index) => {
    const at = (index + 1) * wordMs;
    const last = index === words.length - 1;
    for (const text of segmenter.push(last ? word : `${word} `)) ready.push({ text, at });
    if (last) for (const text of segmenter.finish()) ready.push({ text, at });
  });
  let playing = 0;
  let silenceMs = 0;
  for (const { text, at } of ready) {
    const start = at + ttfbMs;
    if (playing && start > playing) silenceMs += start - playing;
    playing = Math.max(playing, start) + text.length * msPerChar;
  }
  return { firstAudioMs: ready[0]!.at + ttfbMs, silenceMs, segments: ready.map((r) => r.text) };
}

describe('LAT-9 on a fixed timeline', () => {
  it('removes the stall after a one-word first clause', () => {
    const reply = 'Okay, so your EMI of 4,500 rupees is due on the fifth. You can pay it online.';
    const before = timeline(reply, { minFirstWords: 0 });
    const after = timeline(reply, {});
    expect(before.segments[0]).toBe('Okay,');
    // "Okay," is 300 ms of audio, then the caller waits for the rest of the sentence to render.
    expect(before).toMatchObject({ firstAudioMs: 290, silenceMs: 180 });
    expect(after).toMatchObject({ firstAudioMs: 770, silenceMs: 0 });
  });

  it('starts first audio at the first clause instead of the end of a long sentence', () => {
    const reply =
      'Sure Rahul ji, your EMI of 4,500 rupees is due on the fifth of October. Shall I send a link?';
    const clause = timeline(reply, {});
    const sentence = timeline(reply, { minFirstWords: 1_000 });
    expect(clause.segments[0]).toBe('Sure Rahul ji,');
    expect(clause).toMatchObject({ firstAudioMs: 370, silenceMs: 0 });
    // Without the clause cut the first segment waits for the 60-character cap.
    expect(sentence.firstAudioMs - clause.firstAudioMs).toBe(440);
  });
});
