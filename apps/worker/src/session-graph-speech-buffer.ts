import { bytesPerSecond, type AudioFormat } from '@winsendotai/ovo-contracts';
import type { ByteCache } from '@winsendotai/ovo-plugin-cache';

/** Fixed byte capacity, independent of provider chunk size; detached cache producers may finish. */
export class BoundedAudioPrefetch implements AsyncIterable<Uint8Array> {
  private readonly ring: Uint8Array;
  private head = 0;
  private occupied = 0;
  private terminal?: { error?: unknown; detached: boolean };
  private wake!: () => void;
  private transition = this.nextTransition();

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError('maxPrefetchBytes must be a positive integer');
    this.ring = new Uint8Array(maxBytes);
  }

  private nextTransition(): Promise<void> {
    return new Promise((resolve) => (this.wake = resolve));
  }
  private notify(): void {
    const release = this.wake;
    this.transition = this.nextTransition();
    release();
  }

  async push(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    const aborted = () => this.notify();
    signal.addEventListener('abort', aborted, { once: true });
    try {
      let offset = 0;
      while (offset < chunk.byteLength) {
        signal.throwIfAborted();
        if (this.terminal) {
          if (this.terminal.detached) return;
          throw this.terminal.error ?? new Error('Speech prefetch closed');
        }
        if (this.occupied === this.maxBytes) {
          await this.transition;
          continue;
        }
        const tail = (this.head + this.occupied) % this.maxBytes;
        const count = Math.min(
          chunk.byteLength - offset,
          this.maxBytes - this.occupied,
          this.maxBytes - tail,
        );
        this.ring.set(chunk.subarray(offset, offset + count), tail);
        offset += count;
        this.occupied += count;
        this.notify();
      }
    } finally {
      signal.removeEventListener('abort', aborted);
    }
  }

  end(error?: unknown, detached = false): void {
    if (this.terminal) return;
    this.terminal = { error, detached };
    if (detached) this.occupied = 0;
    this.notify();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    for (;;) {
      if (!this.occupied) {
        if (this.terminal) {
          if (this.terminal.error) throw this.terminal.error;
          return;
        }
        await this.transition;
        continue;
      }
      const count = Math.min(this.occupied, this.maxBytes - this.head);
      const owned = this.ring.slice(this.head, this.head + count);
      this.head = (this.head + count) % this.maxBytes;
      this.occupied -= count;
      this.notify();
      yield owned;
    }
  }
}

export function streamCachedAudio(
  cache: ByteCache,
  request: {
    key: string;
    workspaceId: string;
    signal: AbortSignal;
    maxPrefetchBytes: number;
    onSource?(source: 'hit' | 'miss' | 'coalesced'): void;
    load(signal: AbortSignal, push: (chunk: Uint8Array) => Promise<void>): Promise<Uint8Array>;
  },
): { audio: AsyncIterable<Uint8Array>; cancel(): void } {
  const hit = cache.get(request.key, request.workspaceId);
  if (hit) {
    request.onSource?.('hit');
    return { audio: storedAudio(hit, request.maxPrefetchBytes), cancel: () => undefined };
  }
  const buffer = new BoundedAudioPrefetch(request.maxPrefetchBytes);
  let producing = false;
  void cache
    .getOrLoad({
      key: request.key,
      workspaceId: request.workspaceId,
      signal: request.signal,
      onSource: request.onSource,
      load: (signal) => {
        producing = true;
        return request.load(signal, (chunk) => buffer.push(chunk, signal));
      },
    })
    .then(async (result) => {
      if (!producing) await buffer.push(result.value, request.signal);
      buffer.end();
    })
    .catch((error: unknown) => buffer.end(error));
  return {
    audio: buffer,
    cancel: () => buffer.end(undefined, true),
  };
}

export async function* storedAudio(
  audio: Uint8Array,
  chunkBytes: number,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < audio.byteLength; offset += chunkBytes)
    yield audio.slice(offset, offset + chunkBytes);
}

/** The prefetch budget is not a carrier frame limit. Preserve split PCM samples. */
export async function* carrierFrames(
  audio: AsyncIterable<Uint8Array>,
  format: AudioFormat,
): AsyncIterable<Uint8Array> {
  const sampleBytes = format.encoding === 'pcm_s16le' ? 2 : 1;
  const maxBytes = Math.min(
    8192,
    Math.floor(bytesPerSecond(format) / 50 / sampleBytes) * sampleBytes,
  );
  let partial: number | undefined;
  for await (const input of audio) {
    if (!input.length) continue;
    let bytes = input;
    if (partial !== undefined) {
      bytes = new Uint8Array(input.length + 1);
      bytes[0] = partial;
      bytes.set(input, 1);
      partial = undefined;
    }
    const complete = bytes.length - (bytes.length % sampleBytes);
    for (let offset = 0; offset < complete; offset += maxBytes)
      yield bytes.slice(offset, Math.min(offset + maxBytes, complete));
    if (complete < bytes.length) partial = bytes[complete];
  }
  if (partial !== undefined) throw new TypeError('Speech audio ends with an incomplete PCM sample');
}
