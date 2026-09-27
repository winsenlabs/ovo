import type { AudioPlayer, AudioPlaybackRequest } from '@winsendotai/ovo-plugin-speech-cache';
import { carrierFrames, storedAudio } from './session-graph-speech-buffer.ts';
import type {
  AudioFormat,
  PlaybackEvidence,
  SpeechOutputResult,
  SpeechSegment,
  VoiceMediaTransport,
} from '@winsendotai/ovo-contracts';
import { bytesPerSecond, MULAW_8K } from '@winsendotai/ovo-contracts';

type PlaybackResult = SpeechOutputResult & { usage: []; evidenceSource?: PlaybackEvidence };
/** Keep the frozen reporter contract; the result retains accepted weak-evidence provenance. */
type Reporter = (phase: 'sent' | 'acknowledged', evidence: 'estimated' | 'confirmed') => void;
interface PendingMark {
  epoch: number;
  resolve(result: PlaybackResult): void;
  timer: NodeJS.Timeout;
  report?: Reporter;
}

type PlaybackOptions = {
  signal: AbortSignal;
  report?: Reporter;
  afterSent?: () => void;
};

export class CachedMediaAudioPlayer implements AudioPlayer {
  private readonly pending = new Map<string, PendingMark>();
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly media: VoiceMediaTransport,
    private readonly options: {
      frameBytes?: number;
      format?: AudioFormat;
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

  async play(request: AudioPlaybackRequest, options: PlaybackOptions): Promise<PlaybackResult> {
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
  ): Promise<PlaybackResult> {
    return this.playFrames(audio, segment, options, suffix);
  }

  private async playFrames(
    frames: AsyncIterable<Uint8Array>,
    segment: SpeechSegment,
    options: PlaybackOptions,
    suffix?: string,
  ): Promise<PlaybackResult> {
    if (options.signal.aborted) return interrupted();
    const mark = `${segment.id}:${segment.epoch}${suffix ? `:${suffix}` : ''}`;
    const onAbort = () => this.cancel(mark);
    options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      let sent = false;
      for await (const frame of carrierFrames(frames, this.options.format ?? MULAW_8K)) {
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
  ): Promise<PlaybackResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(name);
          resolve({ state: 'completed', evidence: 'estimated', usage: [] });
        },
        Math.ceil(
          (this.media.bufferedBytes / bytesPerSecond(this.options.format ?? MULAW_8K)) * 1_000 +
            (this.options.markTimeoutMs ?? 15_000),
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
    const evidenceSource =
      evidence === 'confirmed' && this.options.playbackEvidence === 'carrier-processed'
        ? ('carrier-processed' as const)
        : undefined;
    pending.report?.('acknowledged', evidence);
    pending.resolve({
      state: 'completed',
      evidence,
      usage: [],
      ...(evidenceSource ? { evidenceSource } : {}),
    });
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

function interrupted(): PlaybackResult {
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
