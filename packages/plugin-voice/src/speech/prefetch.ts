/** Bounded producer/consumer queue: synthesis pauses when playback has not begun. */
export class PrefetchBuffer implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private readonly readers: (() => void)[] = [];
  private readonly writers: (() => void)[] = [];
  private bytes = 0;
  private ended = false;
  private failure?: unknown;

  constructor(private readonly maxBytes: number) {}

  async push(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    if (chunk.length > this.maxBytes) {
      for (let offset = 0; offset < chunk.length; offset += this.maxBytes)
        await this.push(chunk.subarray(offset, offset + this.maxBytes), signal);
      return;
    }
    while (this.bytes + chunk.length > this.maxBytes) {
      signal.throwIfAborted();
      await new Promise<void>((resolve) => this.writers.push(resolve));
    }
    signal.throwIfAborted();
    this.chunks.push(chunk.slice());
    this.bytes += chunk.length;
    this.readers.shift()?.();
  }

  end(error?: unknown): void {
    this.failure = error;
    this.ended = true;
    for (const wake of this.readers.splice(0)) wake();
    for (const wake of this.writers.splice(0)) wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      if (this.chunks.length) {
        const chunk = this.chunks.shift()!;
        this.bytes -= chunk.length;
        this.writers.shift()?.();
        yield chunk;
        continue;
      }
      if (this.failure) throw this.failure;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.readers.push(resolve));
    }
  }
}
