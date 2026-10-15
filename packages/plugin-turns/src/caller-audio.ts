import { PolyphaseResampler } from '@winsendotai/ovo-audio';

const SAMPLE_RATE = 16_000;

/** The last `audioMs` of the caller's audio at 16 kHz, timed by the clock it arrived on. */
export class CallerAudio {
  private readonly buffer: Int16Array;
  private length = 0;
  private resampler?: PolyphaseResampler;
  private lastAt?: number;

  constructor(audioMs: number) {
    this.buffer = new Int16Array((audioMs * SAMPLE_RATE) / 1000);
  }

  push(pcm: Int16Array, rate: 8000 | 16000, now: number): void {
    let samples = pcm;
    if (rate !== SAMPLE_RATE) {
      this.resampler ??= new PolyphaseResampler(rate, SAMPLE_RATE);
      samples = this.resampler.push(pcm);
    }
    const { buffer } = this;
    if (samples.length >= buffer.length) {
      buffer.set(samples.subarray(samples.length - buffer.length));
      this.length = buffer.length;
    } else {
      const keep = Math.min(this.length, buffer.length - samples.length);
      buffer.copyWithin(0, this.length - keep, this.length);
      buffer.set(samples, keep);
      this.length = keep + samples.length;
    }
    this.lastAt = now;
  }

  /** The audio heard since `fromMs` on the clock, up to the last push. */
  since(fromMs: number): Int16Array | undefined {
    if (!this.length || this.lastAt === undefined || this.lastAt < fromMs) return undefined;
    const ms = this.lastAt - fromMs;
    const take = Math.min(this.length, Math.round((ms * SAMPLE_RATE) / 1000));
    return take ? this.buffer.slice(this.length - take, this.length) : undefined;
  }
}
