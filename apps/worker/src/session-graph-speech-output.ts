import type { SpeechOutput, SpeechSegment } from '@winsendotai/ovo-contracts';
import { CachedMediaAudioPlayer, waitForSendSlot } from './cached-media-player.ts';
import { BoundedAudioPrefetch } from './session-graph-speech-buffer.ts';

export interface PreparedAudio {
  audio: AsyncIterable<Uint8Array>;
  cancel(): void;
  suffix?: string;
}
type PendingSpeech = PreparedAudio & {
  epoch: number;
  controller: AbortController;
  prior: Promise<void>;
  playing: boolean;
  release(): void;
  stop(): void;
  detach(): void;
};

/** One carrier send lane for cached and streaming speech; receipts do not hold the lane. */
export class SessionSpeechOutput implements SpeechOutput {
  private readonly pending = new Map<string, PendingSpeech>();
  private readonly interrupted = new Set<number>();
  private sendTail = Promise.resolve();
  private closed = false;

  constructor(
    private readonly player: CachedMediaAudioPlayer,
    private readonly load: (segment: SpeechSegment, signal: AbortSignal) => PreparedAudio,
    private readonly onSent?: (segment: SpeechSegment) => void,
  ) {}

  async prepare(segment: SpeechSegment, signal: AbortSignal): Promise<void> {
    if (
      this.pending.has(segment.id) ||
      signal.aborted ||
      this.closed ||
      this.interrupted.has(segment.epoch)
    )
      return;
    const controller = new AbortController();
    const prior = this.sendTail;
    let finish!: () => void;
    const sent = new Promise<void>((resolve) => (finish = resolve));
    // Cancelled queued segments must retain the predecessor's ordering fence.
    this.sendTail = prior.then(() => sent);
    let audio: PreparedAudio;
    try {
      audio = this.load(segment, controller.signal);
    } catch (error) {
      finish();
      throw error;
    }
    const stop = () => {
      controller.abort(signal.reason ?? new DOMException('speech interrupted', 'AbortError'));
      audio.cancel();
      if (!state.playing) {
        finish();
        state.detach();
        this.pending.delete(segment.id);
      }
    };
    const state: PendingSpeech = {
      ...audio,
      epoch: segment.epoch,
      controller,
      prior,
      playing: false,
      release: finish,
      stop,
      detach: () => signal.removeEventListener('abort', stop),
    };
    this.pending.set(segment.id, state);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  }

  async play(segment: SpeechSegment, options: Parameters<SpeechOutput['play']>[1]) {
    if (options.signal.aborted) {
      this.pending.get(segment.id)?.stop();
      return { state: 'interrupted', evidence: 'estimated' } as const;
    }
    await this.prepare(segment, options.signal);
    const state = this.pending.get(segment.id);
    if (!state) return { state: 'interrupted', evidence: 'estimated' } as const;
    state.playing = true;
    const abort = () => state.stop();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    try {
      await waitForSendSlot(state.prior, state.controller.signal);
      return await this.player.playStream(
        state.audio,
        segment,
        {
          signal: state.controller.signal,
          afterSent: state.release,
          report: (phase, evidence) => {
            if (phase === 'sent') this.onSent?.(segment);
            options.report?.(phase, evidence);
          },
        },
        state.suffix,
      );
    } catch (error) {
      if (state.controller.signal.aborted)
        return { state: 'interrupted', evidence: 'estimated' } as const;
      throw error;
    } finally {
      options.signal.removeEventListener('abort', abort);
      state.controller.abort(new DOMException('speech playback settled', 'AbortError'));
      state.detach();
      state.cancel();
      state.release();
      this.pending.delete(segment.id);
    }
  }

  async interrupt(epoch: number): Promise<void> {
    this.interrupted.add(epoch);
    for (const state of this.pending.values()) if (state.epoch === epoch) state.stop();
    // Fence marks before clear: a carrier may acknowledge flushed marks synchronously.
    this.player.cancelPending(epoch);
    const clearing = this.sendTail.then(() => this.player.interrupt(epoch));
    this.sendTail = clearing;
    await clearing;
  }

  dispose(): void {
    this.closed = true;
    for (const state of this.pending.values()) state.stop();
    this.player.dispose();
  }
}

export function prefetchSpeech(
  audio: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  maxBytes: number,
): PreparedAudio {
  const buffer = new BoundedAudioPrefetch(maxBytes);
  const cancel = () => buffer.end(undefined, true);
  signal.addEventListener('abort', cancel, { once: true });
  void (async () => {
    try {
      for await (const chunk of audio) {
        signal.throwIfAborted();
        await buffer.push(chunk, signal);
      }
      buffer.end();
    } catch (error) {
      buffer.end(error);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  })();
  return { audio: buffer, cancel };
}
