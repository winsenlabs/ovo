import type { AudioFormat } from '@winsendotai/ovo-contracts';

/**
 * One generation's audio, buffered as it arrives so the socket can finish this generation (and
 * start the next) whether or not the speaker is reading yet. Read once, through `read()`.
 */
export class AudioOut {
  private readonly chunks: Uint8Array[] = [];
  private finished = false;
  private error?: unknown;
  private wake?: () => void;

  /** True once nothing more will be added. */
  get closed(): boolean {
    return this.finished;
  }

  push(bytes: Uint8Array): void {
    if (this.finished || !bytes.byteLength) return;
    this.chunks.push(bytes);
    this.notify();
  }

  /** Normal end: what is buffered still plays. */
  end(): void {
    this.finished = true;
    this.notify();
  }

  /**
   * Stops the audio now: anything buffered is dropped, so a barge-in or abort hears nothing more.
   * With an error the reader throws it; without one the reader just ends (a closed reply).
   */
  stop(error?: unknown): void {
    if (this.finished && !this.chunks.length) return;
    this.chunks.length = 0;
    this.finished = true;
    this.error = error;
    this.notify();
  }

  /** `onAbandon` runs when the reader leaves before the end (break, return, or a throw). */
  async *read(onAbandon: () => void): AsyncGenerator<Uint8Array> {
    let complete = false;
    try {
      for (;;) {
        const next = this.chunks.shift();
        if (next) {
          yield next;
          continue;
        }
        if (this.error !== undefined) throw this.error;
        if (this.finished) {
          complete = true;
          return;
        }
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    } finally {
      if (!complete) onAbandon();
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}

/**
 * Re-cuts PCM16 into whole samples. Neither the socket's binary frames nor HTTP body reads promise
 * sample alignment, and a sample split across two writes is a click on the line. μ-law passes as is.
 */
export class WholeSamples {
  private held?: number;
  private readonly pairs: boolean;

  constructor(format: AudioFormat) {
    this.pairs = format.encoding === 'pcm_s16le';
  }

  cut(bytes: Uint8Array): Uint8Array {
    if (!this.pairs) return bytes;
    const start = this.held === undefined ? 0 : 1;
    const total = start + bytes.byteLength;
    const usable = total - (total % 2);
    const out = new Uint8Array(usable);
    if (start && usable) out[0] = this.held!;
    if (usable) out.set(bytes.subarray(0, usable - start), start);
    this.held =
      total % 2 ? (bytes.byteLength ? bytes[bytes.byteLength - 1] : this.held) : undefined;
    return out;
  }

  /** A half sample is still held: the stream ended mid-sample. */
  get partial(): boolean {
    return this.held !== undefined;
  }
}
