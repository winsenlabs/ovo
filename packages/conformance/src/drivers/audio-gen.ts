import { pcm16ToAlaw, pcm16ToBytes, pcm16ToMulaw } from '@winsendotai/ovo-audio';
import type { AudioFormat } from '@winsendotai/ovo-contracts';

/** mulberry32: a tiny deterministic PRNG, so every generated signal is reproducible from a seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const samplesFor = (rate: number, ms: number) => Math.round((rate * ms) / 1000);
const clamp = (value: number) => Math.max(-32768, Math.min(32767, Math.round(value)));

export function tonePcm16(options: {
  freq: number;
  ms: number;
  rate: number;
  amplitude?: number;
}): Int16Array {
  const out = new Int16Array(samplesFor(options.rate, options.ms));
  const amplitude = options.amplitude ?? 12000;
  for (let i = 0; i < out.length; i += 1)
    out[i] = clamp(amplitude * Math.sin((2 * Math.PI * options.freq * i) / options.rate));
  return out;
}

export function noisePcm16(options: {
  seed: number;
  ms: number;
  rate: number;
  amplitude?: number;
}): Int16Array {
  const random = seededRandom(options.seed);
  const out = new Int16Array(samplesFor(options.rate, options.ms));
  const amplitude = options.amplitude ?? 3000;
  for (let i = 0; i < out.length; i += 1) out[i] = clamp((random() * 2 - 1) * amplitude);
  return out;
}

/**
 * A voiced, speech-like signal: a seeded fundamental (100–220 Hz) with decaying harmonics and a
 * 4 Hz syllable envelope. Energy VADs must call it speech; silence must not be.
 */
export function speechLikePcm16(options: { seed: number; ms: number; rate: number }): Int16Array {
  const random = seededRandom(options.seed);
  const f0 = 100 + random() * 120;
  const out = new Int16Array(samplesFor(options.rate, options.ms));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / options.rate;
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
    let value = 0;
    for (let h = 1; h <= 8; h += 1) value += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = clamp(value * 7000 * envelope + (random() * 2 - 1) * 200);
  }
  return out;
}

export function silencePcm16(ms: number, rate: number): Int16Array {
  return new Int16Array(samplesFor(rate, ms));
}

/** PCM16 samples encoded in `format`. The sample rate must already match. */
export function encodeAs(format: AudioFormat, pcm: Int16Array): Uint8Array {
  if (format.encoding === 'mulaw') return pcm16ToMulaw(pcm);
  if (format.encoding === 'alaw') return pcm16ToAlaw(pcm);
  return pcm16ToBytes(pcm);
}

/** `ms` of seeded speech-like audio in `format`. */
export function speechBytes(format: AudioFormat, ms: number, seed = 1): Uint8Array {
  return encodeAs(format, speechLikePcm16({ seed, ms, rate: format.sampleRate }));
}

/** Splits `bytes` into frames of `frameMs` in `format` (the last frame may be short). */
export function framesOf(bytes: Uint8Array, format: AudioFormat, frameMs: number): Uint8Array[] {
  const bytesPerSample = format.encoding === 'pcm_s16le' ? 2 : 1;
  const size = samplesFor(format.sampleRate, frameMs) * bytesPerSample;
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size)
    frames.push(bytes.slice(offset, offset + size));
  return frames;
}
