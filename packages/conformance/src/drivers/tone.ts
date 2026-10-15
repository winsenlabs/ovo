import { alawToPcm16, bytesToPcm16, mulawToPcm16 } from '@winsendotai/ovo-audio';
import type { AudioFormat } from '@winsendotai/ovo-contracts';

/** PCM16 samples of a frame in `format` (mulaw and alaw decoded, pcm_s16le read little-endian). */
export function decodeFrame(frame: Uint8Array, format: AudioFormat): Int16Array {
  if (format.encoding === 'mulaw') return mulawToPcm16(frame);
  if (format.encoding === 'alaw') return alawToPcm16(frame);
  return bytesToPcm16(frame);
}

/**
 * Goertzel power of `freq` in `pcm`, normalised by length so a full-scale tone at `freq` scores
 * about 1 and unrelated tones or noise near 0. Cheap enough to run on every frame of a call.
 */
export function goertzel(pcm: Int16Array, sampleRate: number, freq: number): number {
  if (pcm.length === 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const s0 = pcm[i]! / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (4 * power) / (pcm.length * pcm.length);
}

/** Whether `freq` dominates the frames: its power beats every other candidate and a floor. */
export function hasTone(
  pcm: Int16Array,
  sampleRate: number,
  freq: number,
  others: readonly number[] = [],
  floor = 0.05,
): boolean {
  const own = goertzel(pcm, sampleRate, freq);
  return own >= floor && others.every((other) => own > 4 * goertzel(pcm, sampleRate, other));
}

/** Accumulates frames and answers whether a tone is present in what arrived (for e2e and kits). */
export class ToneListener {
  private chunks: Int16Array[] = [];
  frames = 0;
  constructor(
    private readonly format: AudioFormat,
    private readonly maxSeconds = 10,
  ) {}

  push(frame: Uint8Array): void {
    this.frames += 1;
    this.chunks.push(decodeFrame(frame, this.format));
    let total = this.chunks.reduce((n, c) => n + c.length, 0);
    while (total > this.maxSeconds * this.format.sampleRate && this.chunks.length > 1)
      total -= this.chunks.shift()!.length;
  }

  /** Power of `freq` over the last `ms` of audio received. */
  power(freq: number, ms = 200): number {
    const want = Math.round((this.format.sampleRate * ms) / 1000);
    const all = new Int16Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of this.chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return goertzel(all.subarray(Math.max(0, all.length - want)), this.format.sampleRate, freq);
  }

  heard(freq: number, others: readonly number[] = [], ms = 200): boolean {
    const want = Math.round((this.format.sampleRate * ms) / 1000);
    const all = new Int16Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of this.chunks) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return hasTone(
      all.subarray(Math.max(0, all.length - want)),
      this.format.sampleRate,
      freq,
      others,
    );
  }
}
