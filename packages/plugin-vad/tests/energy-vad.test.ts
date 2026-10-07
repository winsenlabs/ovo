import { describe, expect, it } from 'vitest';
import { mulawToPcm16, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import { speechLikePcm16 } from '@winsendotai/ovo-conformance/drivers';
import { createEnergyVad } from '../src/index.ts';
import { VadState, type VadTransition } from '../src/vad-state.ts';

/**
 * Seeded voiced speech in `intervals` (ms), silence elsewhere: the conformance kit's speech-like
 * signal (a 100–220 Hz fundamental, eight harmonics, a 4 Hz syllable envelope). A steady sine is
 * no longer speech: the analyzer rejects tones.
 */
function fixture(rate: 8000 | 16000, intervals: readonly [number, number][]): Int16Array {
  const speech = speechLikePcm16({ seed: 19, ms: 1650, rate });
  return Int16Array.from(speech, (sample, index) => {
    const ms = (index * 1000) / rate;
    return intervals.some(([start, end]) => ms >= start && ms < end) ? sample : 0;
  });
}

function transitions(rate: 8000 | 16000, pcm: Int16Array): VadTransition[] {
  const factory = createEnergyVad();
  const analyzer = factory.create(rate);
  const state = new VadState(factory.params);
  const result: VadTransition[] = [];
  for (let at = 0; at + analyzer.frameSamples <= pcm.length; at += analyzer.frameSamples) {
    const frame = pcm.slice(at, at + analyzer.frameSamples);
    const transition = state.observe(analyzer.confidence(frame), analyzer.volume(frame));
    if (transition) result.push(transition);
  }
  return result;
}

describe('energy VAD state machine', () => {
  for (const rate of [8000, 16000] as const) {
    it(`${rate} Hz: start and stop indices for seeded speech / pause / speech / silence`, () => {
      const pcm = fixture(rate, [
        [0, 300],
        [450, 850],
      ]);
      // The first burst's syllable dip (-39 dBFS at 187 ms) falls under minVolume before 200 ms
      // of speech accumulate, so only the second burst starts. It stops 250 ms after the burst
      // ends: tone rejection no longer cuts the harmonic signal's steady tail inside the run.
      expect(transitions(rate, pcm)).toEqual([
        { type: 'vad.start', atMs: 640, frame: 32 },
        { type: 'vad.stop', atMs: 1100, frame: 55 },
      ]);
    });
    it(`${rate} Hz: an 80 ms cough is too short`, () => {
      expect(transitions(rate, fixture(rate, [[0, 80]]))).toEqual([]);
    });
    it(`${rate} Hz: a 50 Hz hum does not start speech`, () => {
      const hum = Int16Array.from({ length: rate }, (_, i) =>
        Math.round(18000 * Math.sin((2 * Math.PI * 50 * i) / rate)),
      );
      expect(transitions(rate, hum)).toEqual([]);
    });
  }
  it('8 kHz μ-law round-trip preserves the transition indices', () => {
    const pcm = fixture(8000, [
      [0, 300],
      [450, 850],
    ]);
    expect(transitions(8000, mulawToPcm16(pcm16ToMulaw(pcm)))).toEqual(transitions(8000, pcm));
  });
});
