import { ProviderProtocolError } from './types.ts';

export type SupportedAudioCodec = 'audio/x-mulaw' | 'audio/pcm';

/** Converts OpenAI's documented 24 kHz signed 16-bit LE PCM stream. */
export class OpenAiPcmConverter {
  private byteCarry = new Uint8Array(0);
  private readonly downsampleCarry: number[] = [];

  constructor(
    private readonly codec: SupportedAudioCodec,
    private readonly sampleRate: 8_000 | 24_000,
    private readonly maxChunkBytes: number,
  ) {
    if (sampleRate === 24_000 && codec !== 'audio/pcm')
      throw new TypeError('24 kHz output supports signed 16-bit PCM only');
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1)
      throw new TypeError('maxChunkBytes must be a positive integer');
    if (codec === 'audio/pcm' && maxChunkBytes < 2)
      throw new TypeError('PCM output chunks require at least two bytes');
  }

  push(chunk: Uint8Array): Uint8Array[] {
    const input = join(this.byteCarry, chunk);
    const evenLength = input.byteLength - (input.byteLength % 2);
    this.byteCarry = input.slice(evenLength);
    if (this.sampleRate === 24_000)
      return splitAligned(input.slice(0, evenLength), this.maxChunkBytes, 2);

    const output: number[] = [];
    for (let offset = 0; offset < evenLength; offset += 2) {
      this.downsampleCarry.push(readInt16(input[offset]!, input[offset + 1]!));
      if (this.downsampleCarry.length === 3) {
        output.push(average(this.downsampleCarry));
        this.downsampleCarry.length = 0;
      }
    }
    return this.encode(output);
  }

  finish(): Uint8Array[] {
    if (this.byteCarry.byteLength !== 0)
      throw new ProviderProtocolError('OpenAI returned an incomplete PCM sample');
    if (this.downsampleCarry.length === 0) return [];
    const final = average(this.downsampleCarry);
    this.downsampleCarry.length = 0;
    return this.encode([final]);
  }

  private encode(samples: readonly number[]): Uint8Array[] {
    if (samples.length === 0) return [];
    if (this.codec === 'audio/x-mulaw') {
      const bytes = Uint8Array.from(samples, linear16ToMuLaw);
      return splitAligned(bytes, this.maxChunkBytes, 1);
    }
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
    return splitAligned(bytes, this.maxChunkBytes, 2);
  }
}

export function linear16ToMuLaw(value: number): number {
  const BIAS = 0x84;
  const CLIP = 32_635;
  let sample = Math.max(-32_768, Math.min(32_767, Math.round(value)));
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  sample = Math.min(CLIP, sample) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (sample & mask) === 0; mask >>= 1) exponent -= 1;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function createMonoWav(
  audio: Uint8Array,
  codec: SupportedAudioCodec,
  sampleRate: 8_000 | 24_000,
): Uint8Array {
  if (codec === 'audio/x-mulaw') return createMuLawWav(audio, sampleRate);
  const bitsPerSample = 16;
  if (codec === 'audio/pcm' && audio.byteLength % 2 !== 0)
    throw new TypeError('PCM audio must contain complete signed 16-bit samples');
  const result = new Uint8Array(44 + audio.byteLength);
  const view = new DataView(result.buffer);
  writeAscii(result, 0, 'RIFF');
  view.setUint32(4, result.byteLength - 8, true);
  writeAscii(result, 8, 'WAVE');
  writeAscii(result, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  const bytesPerSample = bitsPerSample / 8;
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(result, 36, 'data');
  view.setUint32(40, audio.byteLength, true);
  result.set(audio, 44);
  return result;
}

function createMuLawWav(audio: Uint8Array, sampleRate: number): Uint8Array {
  // Non-PCM WAVE requires cbSize and a fact chunk containing the sample count.
  const result = new Uint8Array(58 + audio.byteLength);
  const view = new DataView(result.buffer);
  writeAscii(result, 0, 'RIFF');
  view.setUint32(4, result.byteLength - 8, true);
  writeAscii(result, 8, 'WAVE');
  writeAscii(result, 12, 'fmt ');
  view.setUint32(16, 18, true);
  view.setUint16(20, 7, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  view.setUint16(36, 0, true);
  writeAscii(result, 38, 'fact');
  view.setUint32(42, 4, true);
  view.setUint32(46, audio.byteLength, true);
  writeAscii(result, 50, 'data');
  view.setUint32(54, audio.byteLength, true);
  result.set(audio, 58);
  return result;
}

function average(samples: readonly number[]): number {
  return Math.max(
    -32_768,
    Math.min(32_767, Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)),
  );
}

function readInt16(low: number, high: number): number {
  const value = low | (high << 8);
  return value & 0x8000 ? value - 0x1_0000 : value;
}

function join(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function splitAligned(bytes: Uint8Array, maxBytes: number, alignment: number): Uint8Array[] {
  const chunkSize = Math.max(alignment, Math.floor(maxBytes / alignment) * alignment);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize)
    chunks.push(bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  return chunks;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1)
    bytes[offset + index] = value.charCodeAt(index);
}
