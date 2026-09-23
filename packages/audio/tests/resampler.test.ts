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
  it('rejects a 6 kHz alias at least 60 dB below a 1 kHz reference (24k → 8k)', () => {
    const reference = resampleAll(24000, 8000, tone(1000, 24000, 1));
    const alias = resampleAll(24000, 8000, tone(6000, 24000, 1));
    const refAmp = amplitudeAt(steady(reference, 8000), 8000, 1000);
    // 6 kHz folds to 2 kHz at 8 kHz.
    const aliasAmp = amplitudeAt(steady(alias, 8000), 8000, 2000);
    expect(db(aliasAmp / refAmp)).toBeLessThanOrEqual(-60);
  });

  it.each([
    [24000, 8000],
    [24000, 16000],
    [16000, 8000],
    [8000, 16000],
  ])('passes 1 kHz within 0.5 dB (%i → %i)', (from, to) => {
    const input = tone(1000, from, 1);
    const output = resampleAll(from, to, input);
    const inAmp = amplitudeAt(steady(input, from), from, 1000);
    const outAmp = amplitudeAt(steady(output, to), to, 1000);
    expect(Math.abs(db(outAmp / inAmp))).toBeLessThanOrEqual(0.5);
    expect(output.length).toBeGreaterThanOrEqual(Math.floor((input.length * to) / from));
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
