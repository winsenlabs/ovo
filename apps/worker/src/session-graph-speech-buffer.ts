import { bytesPerSecond, type AudioFormat } from '@winsendotai/ovo-contracts';
import type { ByteCache } from '@winsendotai/ovo-plugin-cache';

export class BoundedAudioPrefetch implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private readonly readers: (() => void)[] = [];
  private readonly writers: (() => void)[] = [];
  private bytes = 0;
  private ended = false;
  private detached = false;
  private failure?: unknown;

  constructor(readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError('maxPrefetchBytes must be a positive integer');
  }

  async push(chunk: Uint8Array, signal: AbortSignal): Promise<void> {
    for (let offset = 0; offset < chunk.length; offset += this.maxBytes) {
      const part = chunk.subarray(offset, offset + this.maxBytes);
      while (this.bytes + part.length > this.maxBytes) {
        signal.throwIfAborted();
        if (this.ended) {
          if (this.detached) return;
          throw this.failure ?? new Error('Speech prefetch closed');
        }
        await new Promise<void>((resolve) => this.writers.push(resolve));
      }
      signal.throwIfAborted();
      if (this.ended) {
        if (this.detached) return;
        throw this.failure ?? new Error('Speech prefetch closed');
      }
      this.chunks.push(part.slice());
      this.bytes += part.length;
      this.readers.shift()?.();
    }
  }

  end(error?: unknown, detached = false): void {
    if (this.ended) return;
    this.ended = true;
    this.detached = detached;
    this.failure = error;
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
      } else if (this.failure) throw this.failure;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => this.readers.push(resolve));
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
    load(signal: AbortSignal, push: (chunk: Uint8Array) => Promise<void>): Promise<Uint8Array>;
  },
): { audio: AsyncIterable<Uint8Array>; cancel(): void } {
  const hit = cache.get(request.key, request.workspaceId);
  if (hit) return { audio: storedAudio(hit, request.maxPrefetchBytes), cancel: () => undefined };
  const buffer = new BoundedAudioPrefetch(request.maxPrefetchBytes);
  let producing = false;
  void cache
    .getOrLoad({
      key: request.key,
      workspaceId: request.workspaceId,
      signal: request.signal,
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
