import { MULAW_8K, PCM16_16K, PCM16_8K, type AudioFormat } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import {
  bytesToPcm16,
  concatBytes,
  createReframer,
  goertzelPower,
  mulawToPcm16,
  pcm16ToBytes,
  pcm16ToMulaw,
  toneShare,
} from '../src/index.ts';

const PCM16_48K: AudioFormat = { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 };

function sine(rate: number, freq: number, ms: number, amplitude = 12_000): Int16Array {
  const out = new Int16Array(Math.round((rate * ms) / 1000));
  for (let i = 0; i < out.length; i += 1)
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
  return out;
}
const mulawTone = (freq: number, ms: number) => pcm16ToMulaw(sine(8000, freq, ms));
const chunked = (bytes: Uint8Array, sizes: number[]) => {
  const parts: Uint8Array[] = [];
  for (let offset = 0, i = 0; offset < bytes.byteLength; i += 1) {
    const size = sizes[i % sizes.length]!;
    parts.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return parts;
};

describe('goertzelPower and toneShare', () => {
  it('reads (A·N/2)² for a sine at the probed frequency', () => {
    const n = 800;
    const power = goertzelPower(sine(8000, 1000, 100, 10_000), 8000, 1000);
    expect(power / ((10_000 * n) / 2) ** 2).toBeCloseTo(1, 3);
  });

  it('tells two tones apart and reads silence as zero', () => {
    const a = sine(8000, 1000, 100);
    expect(toneShare(a, 8000, 1000)).toBeGreaterThan(0.99);
    expect(toneShare(a, 8000, 1500)).toBeLessThan(0.001);
    expect(toneShare(a, 8000, 2000)).toBeLessThan(0.001);
    expect(toneShare(new Int16Array(800), 8000, 1000)).toBe(0);
    expect(toneShare([], 8000, 1000)).toBe(0);
  });

  it('gives a mix of two tones each about half the energy', () => {
    const mix = sine(8000, 1000, 200, 6000).map((v, i) => v + sine(8000, 2000, 200, 6000)[i]!);
    expect(toneShare(mix, 8000, 1000)).toBeCloseTo(0.5, 1);
    expect(toneShare(mix, 8000, 2000)).toBeCloseTo(0.5, 1);
  });
});

describe('createReframer', () => {
  it('turns 20 ms of μ-law 8k into one 640-byte PCM16 16k frame', () => {
    const reframer = createReframer(MULAW_8K, PCM16_16K);
    const frames = [...Array(10)].flatMap(() => reframer.push(mulawTone(1000, 20)));
    expect(frames.length).toBeGreaterThanOrEqual(9);
    expect(frames.every((frame) => frame.byteLength === 640)).toBe(true);
  });

  it('emits identical frames however the input is chunked', () => {
    const input = mulawTone(1000, 400);
    const whole = createReframer(MULAW_8K, PCM16_16K).push(input);
    for (const sizes of [[160], [1], [7, 13, 160], [159, 161]]) {
      const reframer = createReframer(MULAW_8K, PCM16_16K);
      const frames = chunked(input, sizes).flatMap((chunk) => reframer.push(chunk));
      expect(frames.length).toBe(whole.length);
      frames.forEach((frame, i) =>
        expect(Buffer.from(frame).equals(Buffer.from(whole[i]!))).toBe(true),
      );
    }
  });

  it('collects 10 ms PCM16 chunks into 20 ms μ-law frames (160 bytes)', () => {
    const reframer = createReframer(PCM16_8K, MULAW_8K);
    const chunk = pcm16ToBytes(sine(8000, 1000, 10));
    expect(chunk.byteLength).toBe(160);
    expect(reframer.push(chunk)).toEqual([]);
    const out = reframer.push(chunk);
    expect(out).toHaveLength(1);
    expect(out[0]!.byteLength).toBe(160);
  });

  it('does not change the audio on the identity path, still framed', () => {
    const reframer = createReframer(MULAW_8K, MULAW_8K);
    const input = mulawTone(1000, 60);
    const frames = reframer.push(input);
    expect(frames).toHaveLength(3);
    expect(Buffer.from(concatBytes(frames)).equals(Buffer.from(input))).toBe(true);
  });

  it('keeps digital silence silent through the chain', () => {
    const reframer = createReframer(MULAW_8K, PCM16_16K);
    const frames = reframer.push(new Uint8Array(1600).fill(0xff));
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) expect(bytesToPcm16(frame).every((v) => v === 0)).toBe(true);
  });

  it.each([
    ['PCM16 16k', PCM16_16K],
    ['PCM16 48k', PCM16_48K],
  ])(
    'carries a tone through μ-law 8k → %s → μ-law 8k with the energy where it started',
    (_n, room) => {
      for (const freq of [440, 1000, 2500]) {
        const up = createReframer(MULAW_8K, room);
        const down = createReframer(room, MULAW_8K);
        const frames = chunked(mulawTone(freq, 600), [160])
          .flatMap((chunk) => up.push(chunk))
          .flatMap((frame) => down.push(frame));
        const pcm = mulawToPcm16(concatBytes(frames));
        expect(frames.every((frame) => frame.byteLength === 160)).toBe(true);
        // Skip the resampler start-up, then expect a clean tone at the original frequency only.
        const steady = pcm.subarray(1600);
        expect(toneShare(steady, 8000, freq)).toBeGreaterThan(0.95);
      }
    },
  );

  it('keeps two tones separable after the round trip (the e2e tone check)', () => {
    const up = createReframer(MULAW_8K, PCM16_48K);
    const down = createReframer(PCM16_48K, MULAW_8K);
    const run = (freq: number) =>
      mulawToPcm16(
        concatBytes(
          chunked(mulawTone(freq, 500), [160])
            .flatMap((chunk) => up.push(chunk))
            .flatMap((frame) => down.push(frame)),
        ),
      ).subarray(1200);
    const a = run(1000);
    expect(toneShare(a, 8000, 1000)).toBeGreaterThan(0.9);
    expect(toneShare(a, 8000, 1800)).toBeLessThan(0.01);
  });

  it('reset drops buffered audio and resampler history', () => {
    const reframer = createReframer(MULAW_8K, PCM16_16K);
    reframer.push(new Uint8Array(100).fill(0x10));
    reframer.reset();
    expect(reframer.push(new Uint8Array(159).fill(0xff))).toEqual([]);
  });

  it('refuses a pair with no conversion', () => {
    expect(() => createReframer(MULAW_8K, { ...PCM16_16K, sampleRate: 22_050 })).toThrow(
      /No conversion/,
    );
  });
});
