import { describe, expect, it } from 'vitest';
import { mulawToPcm16, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import { createEnergyVad } from '../src/index.ts';
import { VadState, type VadTransition } from '../src/vad-state.ts';

function fixture(rate: 8000 | 16000, intervals: readonly [number, number][]): Int16Array {
  let state = 19;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const samples = Math.round(rate * 1.65);
  return Int16Array.from({ length: samples }, (_, index) => {
    const ms = index * 1000 / rate;
    if (!intervals.some(([start, end]) => ms >= start && ms < end)) return 0;
    return Math.round(16000 * Math.sin(2 * Math.PI * 170 * index / rate) + (random() - 0.5) * 400);
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
      const pcm = fixture(rate, [[0, 300], [450, 850]]);
      expect(transitions(rate, pcm)).toEqual([
        { type: 'vad.start', atMs: 180, frame: 9 },
        { type: 'vad.stop', atMs: 1040, frame: 52 },
      ]);
    });
    it(`${rate} Hz: an 80 ms cough is too short`, () => {
      expect(transitions(rate, fixture(rate, [[0, 80]]))).toEqual([]);
    });
    it(`${rate} Hz: a 50 Hz hum does not start speech`, () => {
      const hum = Int16Array.from({ length: rate }, (_, i) => Math.round(18000 * Math.sin(2 * Math.PI * 50 * i / rate)));
      expect(transitions(rate, hum)).toEqual([]);
    });
  }
  it('8 kHz μ-law round-trip preserves the transition indices', () => {
    const pcm = fixture(8000, [[0, 300], [450, 850]]);
    expect(transitions(8000, mulawToPcm16(pcm16ToMulaw(pcm)))).toEqual(transitions(8000, pcm));
  });
});
