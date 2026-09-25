import type { AudioPlayer, AudioPlaybackRequest } from '@winsendotai/ovo-plugin-speech-cache';
import type { ByteCache } from '@winsendotai/ovo-plugin-cache';
import type {
  PlaybackEvidence,
  SpeechOutputResult,
  SpeechSegment,
  VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';

interface PendingMark {
  epoch: number;
  resolve(result: SpeechOutputResult & { usage: [] }): void;
  timer: NodeJS.Timeout;
  report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
}

type PlaybackOptions = {
  signal: AbortSignal;
  report?: (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
  afterSent?: () => void;
};

export class CachedMediaAudioPlayer implements AudioPlayer {
  private readonly pending = new Map<string, PendingMark>();
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly media: VoiceMediaTransport,
    private readonly options: {
      frameBytes?: number;
      markTimeoutMs?: number;
      playbackEvidence?: PlaybackEvidence;
      allowWeakEvidence?: boolean;
    } = {},
  ) {
    this.unsubscribe = [
      media.onMark(this.confirm.bind(this)),
      media.onClose(() => this.interruptAll()),
    ];
  }

  configure(options: { markTimeoutMs?: number }): void {
    if (options.markTimeoutMs !== undefined) this.options.markTimeoutMs = options.markTimeoutMs;
  }

  async play(
    request: AudioPlaybackRequest,
    options: PlaybackOptions,
  ): Promise<SpeechOutputResult & { usage: [] }> {
    if (request.codec !== 'audio/x-mulaw' || request.sampleRate !== 8_000)
      throw new TypeError('Live cached playback requires 8 kHz mu-law audio');
    const frames = storedAudio(request.audio, this.options.frameBytes ?? 160);
    return this.playFrames(frames, request.segment, options, 'cache');
  }

  playStream(
    audio: AsyncIterable<Uint8Array>,
    segment: SpeechSegment,
    options: PlaybackOptions,
    suffix?: string,
  ): Promise<SpeechOutputResult & { usage: [] }> {
    return this.playFrames(audio, segment, options, suffix);
  }

  private async playFrames(
    frames: AsyncIterable<Uint8Array>,
    segment: SpeechSegment,
    options: PlaybackOptions,
    suffix?: string,
  ): Promise<SpeechOutputResult & { usage: [] }> {
    if (options.signal.aborted) return interrupted();
    const mark = `${segment.id}:${segment.epoch}${suffix ? `:${suffix}` : ''}`;
    const onAbort = () => this.cancel(mark);
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      let sent = false;
      for await (const frame of frames) {
        options.signal.throwIfAborted();
        if (frame.byteLength === 0) continue;
        await this.media.sendAudio(frame, options.signal);
        if (!sent) {
          sent = true;
          options.report?.('sent', 'estimated');
        }
      }
      options.signal.throwIfAborted();
      const completion = this.waitForMark(mark, segment.epoch, options.report);
      await this.media.sendMark(mark, options.signal);
      options.afterSent?.();
      return await completion;
    } catch (error) {
      this.cancel(mark);
      if (options.signal.aborted) return interrupted();
      throw error;
    } finally {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  async interrupt(epoch: number): Promise<void> {
    this.cancelPending(epoch);
    await this.media.clear();
  }

  cancelPending(epoch: number): void {
    for (const [name, pending] of this.pending) if (pending.epoch === epoch) this.cancel(name);
  }

  dispose(): void {
    this.interruptAll();
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  private waitForMark(
    name: string,
    epoch: number,
    report?: PendingMark['report'],
  ): Promise<SpeechOutputResult & { usage: [] }> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(name);
          resolve({ state: 'completed', evidence: 'estimated', usage: [] });
        },
        Math.ceil(
          (this.media.bufferedBytes / 8_000) * 1_000 + (this.options.markTimeoutMs ?? 15_000),
        ),
      );
      timer.unref?.();
      this.pending.set(name, { epoch, resolve, timer, report });
    });
  }

  private confirm(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(name);
    const evidence =
      this.options.playbackEvidence === 'none' ||
      (this.options.playbackEvidence === 'carrier-processed' && !this.options.allowWeakEvidence)
        ? 'estimated'
        : 'confirmed';
    pending.report?.('acknowledged', evidence);
    pending.resolve({ state: 'completed', evidence, usage: [] });
  }

  private cancel(name: string): void {
    const pending = this.pending.get(name);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(name);
    pending.resolve(interrupted());
  }

  private interruptAll(): void {
    for (const name of [...this.pending.keys()]) this.cancel(name);
  }
}

function interrupted(): SpeechOutputResult & { usage: [] } {
  return { state: 'interrupted', evidence: 'estimated', usage: [] };
}

export async function* observeFirstByte(
  audio: AsyncIterable<Uint8Array>,
  onFirstByte: () => void,
): AsyncIterable<Uint8Array> {
  let firstByte = true;
  for await (const chunk of audio) {
    if (firstByte && chunk.byteLength > 0) {
      firstByte = false;
      onFirstByte();
    }
    yield chunk;
  }
}

export function waitForSendSlot(prior: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void prior.then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

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

async function* storedAudio(audio: Uint8Array, chunkBytes: number): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < audio.byteLength; offset += chunkBytes)
    yield audio.slice(offset, offset + chunkBytes);
}
