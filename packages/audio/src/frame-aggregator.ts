import type { AudioFormat } from '@winsendotai/ovo-contracts';
import { concatBytes } from './pcm.ts';
import { bytesForMs, padWithSilence } from './silence.ts';

/**
 * Re-frames an arbitrary byte stream into fixed `frameMs` frames (the STT adapter's `frameMs.preferred`).
 * Frames always hold whole samples; the remainder waits for the next push or `flush()`.
 */
export class FrameAggregator {
  readonly frameBytes: number;
  private chunks: Uint8Array[] = [];
  private pending = 0;

  constructor(
    readonly format: AudioFormat,
    readonly frameMs: number,
  ) {
    if (!(frameMs > 0)) throw new RangeError('frameMs must be positive');
    this.frameBytes = bytesForMs(format, frameMs);
    if (this.frameBytes <= 0) throw new RangeError('frameMs is shorter than one sample');
  }

  get pendingBytes(): number {
    return this.pending;
  }

  push(bytes: Uint8Array): Uint8Array[] {
    if (bytes.byteLength) {
      this.chunks.push(bytes);
      this.pending += bytes.byteLength;
    }
    if (this.pending < this.frameBytes) return [];
    const all = concatBytes(this.chunks);
    const frames: Uint8Array[] = [];
    let offset = 0;
    for (; offset + this.frameBytes <= all.byteLength; offset += this.frameBytes)
      frames.push(all.slice(offset, offset + this.frameBytes));
    const rest = all.slice(offset);
    this.chunks = rest.byteLength ? [rest] : [];
    this.pending = rest.byteLength;
    return frames;
  }

  /**
   * The remainder as one frame (whole samples only), padded with silence to `padToMs` when shorter.
   * Undefined when nothing is pending.
   */
  flush(options: { padToMs?: number } = {}): Uint8Array | undefined {
    const all = concatBytes(this.chunks);
    this.chunks = [];
    this.pending = 0;
    const sample = this.format.encoding === 'pcm_s16le' ? 2 : 1;
    const whole = all.subarray(0, all.byteLength - (all.byteLength % sample));
    if (whole.byteLength === 0) return undefined;
    if (options.padToMs === undefined) return whole.slice();
    return padWithSilence(whole.slice(), bytesForMs(this.format, options.padToMs), this.format);
  }

  reset(): void {
    this.chunks = [];
    this.pending = 0;
  }
}
