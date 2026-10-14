import { describe, expect, it } from 'vitest';
import { lastWindow, logMel, N_FRAMES, N_MELS, WINDOW_SAMPLES } from '../src/features.ts';
import { REFERENCE, synth } from './synth.ts';

describe('Smart Turn features', () => {
  it('match transformers WhisperFeatureExtractor(chunk_length=8, do_normalize=True)', () => {
    const features = logMel(lastWindow(synth()));
    expect(features.length).toBe(N_MELS * N_FRAMES);
    for (const [mel, frame, value] of REFERENCE.points)
      expect(features[mel * N_FRAMES + frame]).toBeCloseTo(value, 4);
    const mean = features.reduce((sum, x) => sum + x, 0) / features.length;
    expect(mean).toBeCloseTo(REFERENCE.mean, 4);
  });

  it('keep the last 8 s, left-padding shorter audio with silence', () => {
    const short = lastWindow(Int16Array.from([16384, -16384]));
    expect(short.length).toBe(WINDOW_SAMPLES);
    expect([...short.slice(-3)]).toEqual([0, 0.5, -0.5]);
    const long = new Int16Array(WINDOW_SAMPLES + 5).map((_, i) => (i < 5 ? 1000 : 0));
    expect(lastWindow(long).every((x) => x === 0)).toBe(true);
  });
});
