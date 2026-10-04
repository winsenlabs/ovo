import { describe, expect, it } from 'vitest';
import { PCM16_16K, PCM16_24K, PCM16_8K, MULAW_8K } from '@winsendotai/ovo-contracts';
import {
  PolyphaseResampler,
  concatBytes,
  concatPcm16,
  createTranscoder,
  pcm16ToBytes,
  plan,
} from '../src/index.ts';

const fixedClock = () => 0;

function tone(freq: number, rate: number, seconds: number, amplitude = 16000): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}

/** Amplitude of `freq` in `signal` (single-bin DFT over a steady-state window). */
function amplitudeAt(signal: Int16Array, rate: number, freq: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < signal.length; i += 1) {
    const phase = (2 * Math.PI * freq * i) / rate;
    re += signal[i]! * Math.cos(phase);
    im -= signal[i]! * Math.sin(phase);
  }
  return (2 * Math.hypot(re, im)) / signal.length;
}

const steady = (signal: Int16Array, rate: number) =>
  signal.subarray(Math.round(rate * 0.1), Math.round(rate * 0.1) + rate / 2);
const db = (ratio: number) => 20 * Math.log10(ratio);

function resampleAll(from: number, to: number, input: Int16Array, chunk?: number): Int16Array {
  const resampler = new PolyphaseResampler(from, to, { now: fixedClock });
  const parts: Int16Array[] = [];
  if (!chunk) parts.push(resampler.push(input));
  else
    for (let i = 0; i < input.length; i += chunk)
      parts.push(resampler.push(input.subarray(i, i + chunk)));
  parts.push(resampler.flush());
  return concatPcm16(parts);
}

describe('PolyphaseResampler', () => {
  // Probe the transition band, just above the output Nyquist, where aliases actually land. A tone
  // far into the stop band (6 kHz into 8 kHz) resamples to digital silence and would pass however
  // wide the transition got, so it proves nothing.
  it.each([
    [24000, 8000],
    [16000, 8000],
    [48000, 8000],
    [48000, 16000],
    [24000, 16000],
    [48000, 24000],
  ])('rejects every fold-back at least 60 dB below a reference tone (%i → %i)', (from, to) => {
    const outputNyquist = to / 2;
    const reference = amplitudeAt(
      steady(resampleAll(from, to, tone(outputNyquist / 4, from, 1)), to),
      to,
      outputNyquist / 4,
    );
    for (let freq = outputNyquist + 50; freq < from / 2; freq += 100) {
      const folded = Math.abs(((freq + outputNyquist) % to) - outputNyquist);
      if (folded < 150 || folded > outputNyquist - 150) continue;
      const aliasAmp = amplitudeAt(
        steady(resampleAll(from, to, tone(freq, from, 1)), to),
        to,
        folded,
      );
      expect(db(aliasAmp / reference), `${freq} Hz folds to ${folded} Hz`).toBeLessThanOrEqual(-60);
    }
  });

  it.each([
    [24000, 8000],
    [24000, 16000],
    [16000, 8000],
    [8000, 16000],
    [48000, 8000],
  ])('holds the pass band within 0.5 dB up to 0.85 Nyquist (%i → %i)', (from, to) => {
    const edge = 0.85 * (Math.min(from, to) / 2);
    for (const fraction of [0.075, 0.25, 0.5, 0.75, 0.9, 1]) {
      const freq = Math.round(edge * fraction);
      const input = tone(freq, from, 1);
      const output = resampleAll(from, to, input);
      const inAmp = amplitudeAt(steady(input, from), from, freq);
      const outAmp = amplitudeAt(steady(output, to), to, freq);
      expect(Math.abs(db(outAmp / inAmp)), `${freq} Hz`).toBeLessThanOrEqual(0.5);
      expect(output.length).toBeGreaterThanOrEqual(Math.floor((input.length * to) / from));
    }
  });

  it('passes equal rates through untouched instead of low-passing them', () => {
    const resampler = new PolyphaseResampler(8000, 8000, { now: fixedClock });
    expect(resampler.prototypeTaps).toBe(1);
    const input = tone(3500, 8000, 0.2);
    const output = resampler.push(input);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('drains the whole filter tail on flush, not just the group delay', () => {
    const resampler = new PolyphaseResampler(24000, 8000, { now: fixedClock });
    resampler.push(tone(1000, 24000, 0.1));
    const tail = resampler.flush();
    // The history is taps-1 input samples long; a group-delay-only drain loses most of it.
    const drained = Math.ceil((resampler.prototypeTaps - 1) / resampler.down);
    expect(tail.length).toBeGreaterThanOrEqual(drained);
  });

  it('keeps stop-band rejection at 24k → 16k for a 10 kHz tone', () => {
    const reference = resampleAll(24000, 16000, tone(1000, 24000, 1));
    const alias = resampleAll(24000, 16000, tone(10000, 24000, 1));
    const refAmp = amplitudeAt(steady(reference, 16000), 16000, 1000);
    const aliasAmp = amplitudeAt(steady(alias, 16000), 16000, 6000);
    expect(db(aliasAmp / refAmp)).toBeLessThanOrEqual(-60);
  });

  it.each([7, 1, 160, 333])('is bit-identical for %i-sample chunks', (chunk) => {
    const input = tone(440, 24000, 0.25);
    expect(resampleAll(24000, 8000, input, chunk)).toEqual(resampleAll(24000, 8000, input));
    expect(resampleAll(8000, 16000, input, chunk)).toEqual(resampleAll(8000, 16000, input));
  });

  it('clears history after an idle gap longer than clearAfterIdleMs', () => {
    let now = 0;
    const resampler = new PolyphaseResampler(24000, 8000, { now: () => now });
    const loud = tone(1000, 24000, 0.05);
    resampler.push(loud);
    now = 250;
    const afterGap = resampler.push(new Int16Array(240));
    expect(afterGap.every((sample) => sample === 0)).toBe(true);
    now = 260;
    const fresh = new PolyphaseResampler(24000, 8000, { now: () => 0 });
    fresh.push(loud);
    expect(fresh.push(new Int16Array(240)).some((sample) => sample !== 0)).toBe(true);
  });

  it('rejects unsupported ratios', () => {
    expect(() => new PolyphaseResampler(22050, 8000)).toThrow(RangeError);
  });
});

describe('createTranscoder', () => {
  it('produces identical μ-law 8k from PCM16 24k whether fed whole or one byte at a time', () => {
    const bytes = pcm16ToBytes(tone(700, 24000, 0.2));
    const oneShot = createTranscoder(plan(PCM16_24K, MULAW_8K)!, { now: fixedClock });
    const whole = concatBytes([oneShot.push(bytes), oneShot.flush()]);
    const bytewise = createTranscoder(plan(PCM16_24K, MULAW_8K)!, { now: fixedClock });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 1) parts.push(bytewise.push(bytes.subarray(i, i + 1)));
    parts.push(bytewise.flush());
    expect(concatBytes(parts)).toEqual(whole);
    expect(whole.length).toBeGreaterThan(1500);
  });

  it('handles odd-byte chunk boundaries for PCM16 → PCM16', () => {
    const bytes = pcm16ToBytes(tone(300, 16000, 0.1));
    const whole = createTranscoder(plan(PCM16_16K, PCM16_8K)!, { now: fixedClock });
    const expected = concatBytes([whole.push(bytes), whole.flush()]);
    const odd = createTranscoder(plan(PCM16_16K, PCM16_8K)!, { now: fixedClock });
    const parts: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 3) parts.push(odd.push(bytes.subarray(i, i + 3)));
    parts.push(odd.flush());
    expect(concatBytes(parts)).toEqual(expected);
  });
});
